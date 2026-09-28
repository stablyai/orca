import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
export { runProcess } from '../../shared/child-process/run-process'
import { setAppEnvironment } from '../../shared/app-environment'
import { DaemonClient } from './client'
import { launchDaemonChild, terminateLaunchedDaemonChild } from './daemon-launched-child'
import { DaemonPtyAdapter } from './daemon-pty-adapter'
import { HistoryReader } from './history-reader'

export async function qualifyPackagedTerminal(resourcesDirectory: string) {
  const resources = resolve(resourcesDirectory)
  const runtime = join(resources, 'cli-runtime', 'bun-runtime')
  const entry = join(resources, 'terminal-daemon', 'daemon-entry.js')
  for (const path of [runtime, entry]) {
    assert(existsSync(path), `Missing packaged terminal artifact: ${path}`)
  }
  const root = mkdtempSync(join(tmpdir(), 'orca-terminal-floor-'))
  setAppEnvironment({
    getPath: () => root,
    getAppPath: () => resources,
    getVersion: () => 'floor-qualification',
    isPackaged: () => true,
    onWillQuit: () => {},
    exit: () => {},
    getAppMetrics: () => []
  })
  process.env.ORCA_DIAGNOSTICS_DISABLED = '1'
  process.env.ORCA_BACKGROUND_LAUNCH = '1'
  const socketPath = join(root, 'daemon.sock')
  const tokenPath = join(root, 'daemon.token')
  const historyPath = join(root, 'history')
  const options = { socketPath, tokenPath, historyPath, profileScope: root }
  const control = new DaemonClient({ socketPath, tokenPath })
  let adapter: DaemonPtyAdapter | undefined
  let launched: Awaited<ReturnType<typeof launchDaemonChild>> | undefined
  let daemonExited = false
  let output = ''
  const exits: { id: string; code: number }[] = []
  const waitFor = async (predicate: () => boolean, label: string) => {
    const deadline = Date.now() + 15_000
    while (!predicate()) {
      assert(Date.now() < deadline, `Timed out: ${label}; daemonExited=${daemonExited}; ${output}`)
      await delay(20)
    }
  }
  const connectAdapter = () => {
    const next = new DaemonPtyAdapter(options)
    next.onData(({ data }) => {
      output = (output + data).slice(-64 * 1024)
    })
    next.onExit(({ id, code }) => {
      exits.push({ id, code })
    })
    return next
  }
  try {
    launched = await launchDaemonChild({
      entryPath: entry,
      forkEntryPath: entry,
      relocatedExecPath: runtime,
      bunRuntime: true,
      userDataPath: root,
      socketPath,
      tokenPath,
      pidPath: join(root, 'daemon.pid'),
      launchNonce: randomUUID(),
      macosLoginSessionWatch: false
    })
    launched.child.on('exit', () => {
      daemonExited = true
    })
    await control.ensureConnected()
    const identity = control.getDaemonIdentity()
    adapter = connectAdapter()
    const spawned = await adapter.spawn({
      cols: 80,
      rows: 24,
      cwd: root,
      shellOverride: '/bin/sh',
      env: { HOME: root, SHELL: '/bin/sh', PS1: '' }
    })
    adapter.write(
      spawned.id,
      'stty -echo; ORCA_FLOOR_MEMORY=retained; printf \'FLOOR_%s_PID_%s\\n\' ready "$$"\r'
    )
    await waitFor(() => /FLOOR_ready_PID_([0-9]+)/.test(output), 'initial shell output')
    const shellPid = output.match(/FLOOR_ready_PID_([0-9]+)/)?.[1]
    assert(shellPid)
    adapter.resize(spawned.id, 103, 37)
    assert.equal(daemonExited, false)
    await control.request('ping', {})
    // Read the kernel size repeatedly because adapter resize delivery is asynchronous.
    for (let attempt = 0; !output.includes('FLOOR_SIZE_37 103') && attempt < 50; attempt++) {
      adapter.write(spawned.id, "printf 'FLOOR_SIZE_'; stty size\r")
      await delay(50)
    }
    assert(output.includes('FLOOR_SIZE_37 103'), 'PTY kernel did not receive resize')
    const snapshot = await adapter.getBufferSnapshot(spawned.id)
    assert(snapshot?.data.includes(`FLOOR_ready_PID_${shellPid}`))
    await adapter.disconnectOnly()
    adapter = undefined
    const history = await new HistoryReader(historyPath).detectColdRestore(spawned.id)
    assert(
      history &&
        (history.snapshotAnsi + history.scrollbackAnsi).includes(`FLOOR_ready_PID_${shellPid}`)
    )
    adapter = connectAdapter()
    const attached = await adapter.spawn({
      sessionId: spawned.id,
      attachOnly: true,
      cols: 103,
      rows: 37
    })
    assert.equal(attached.id, spawned.id)
    assert.deepEqual(adapter.getDaemonIdentity(), identity)
    adapter.write(spawned.id, 'printf \'FLOOR_RECONNECT_%s_PID_%s\\n\' "$ORCA_FLOOR_MEMORY" "$$"\r')
    await waitFor(
      () => output.includes(`FLOOR_RECONNECT_retained_PID_${shellPid}`),
      'retained shell after reconnect'
    )
    adapter.write(spawned.id, 'exit 17\r')
    await waitFor(() => exits.some((event) => event.id === spawned.id), 'observed shell exit')
    assert.deepEqual(exits, [{ id: spawned.id, code: 17 }])
    await adapter.disconnectOnly()
    adapter = undefined
    await control.request('shutdown', { killSessions: true })
    await waitFor(() => daemonExited, 'daemon graceful shutdown')
    return {
      passed: true,
      platform: process.platform,
      arch: process.arch,
      clientRuntime: process.version,
      electronVersion: process.versions.electron,
      runtimeSha256: createHash('sha256').update(readFileSync(runtime)).digest('hex'),
      entrySha256: createHash('sha256').update(readFileSync(entry)).digest('hex'),
      shellPid: Number(shellPid),
      resize: true,
      reconnect: true,
      history: true,
      exitCode: 17
    }
  } finally {
    adapter?.dispose()
    control.disconnect()
    if (launched && !daemonExited) {
      await terminateLaunchedDaemonChild(launched.child)
    }
    rmSync(root, { recursive: true, force: true })
  }
}
