/* oxlint-disable eslint/curly, typescript/no-explicit-any -- standalone macOS validation prototype shipped with the design evidence */

import { fork } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync } from 'node:fs'
import { opendir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import assert from 'node:assert/strict'
import { startDaemon } from '../../../src/main/daemon/daemon-main'
import { DaemonClient } from '../../../src/main/daemon/client'
import { createPtySubprocess } from '../../../src/main/daemon/pty-subprocess'
import { prepareMacosTccLoginShell } from '../../../src/main/providers/macos-tcc-login-shell'

async function runHost(root: string) {
  const daemon = await startDaemon({
    socketPath: join(root, 'probe.sock'),
    tokenPath: join(root, 'probe.token'),
    spawnSubprocess: (opts) =>
      createPtySubprocess({
        ...opts,
        onMacosTccSpawnStrategy: (strategy) => process.send?.({ strategy })
      }),
    ...(process.env.ORCA_PROBE_WRAPPED === '1'
      ? { preparePtySpawn: prepareMacosTccLoginShell }
      : {})
  })
  process.send?.({ ready: true, pid: process.pid })
  process.once('message', async () => {
    await daemon.shutdown()
    process.disconnect()
  })
}

async function appRead(target: string) {
  try {
    const dir = await opendir(target)
    try {
      await dir.read()
    } finally {
      await dir.close()
    }
    return 'ok'
  } catch (error) {
    return error instanceof Error && 'code' in error ? String(error.code) : 'unknown'
  }
}

async function runParent(helper: string) {
  const root = mkdtempSync(join(tmpdir(), 'orca-tcc-probe-'))
  const unusual = join(root, "folder with ' quote $dollar `backtick`\nand newline")
  const denied = join(root, 'denied')
  mkdirSync(unusual)
  mkdirSync(denied)
  chmodSync(denied, 0)
  const host = fork(__filename, ['--host', root], { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] })
  const exited = new Promise<number | null>((resolve) => host.once('exit', resolve))
  const client = new DaemonClient({
    socketPath: join(root, 'probe.sock'),
    tokenPath: join(root, 'probe.token')
  })
  try {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('host startup timeout')), 10000)
      host.once('message', () => {
        clearTimeout(timer)
        resolve()
      })
      host.once('error', reject)
    })
    await client.ensureConnectedWithin(3000)
    host.on('message', (message) => {
      if (typeof message === 'object' && message && 'strategy' in message)
        console.log(JSON.stringify(message))
    })
    for (const [name, target, expected] of [
      ['readable', unusual, 0],
      ['missing', join(root, 'missing'), 2],
      ['denied', denied, 13]
    ] as const) {
      const sessionId = `probe-${randomUUID()}`
      const nonce = randomUUID()
      let output = ''
      let finish: (() => void) | undefined
      const completion = new Promise<void>((resolve) => {
        finish = resolve
      })
      const unsubscribe = client.onEvent((event: any) => {
        if (event.sessionId !== sessionId) return
        if (event.event === 'data') output += event.payload.data
        if (event.event === 'exit') finish?.()
      })
      try {
        const created = await client.request<any>(
          'createOrAttach',
          {
            sessionId,
            cols: 80,
            rows: 24,
            cwd: root,
            shellOverride: helper,
            env: { ORCA_PROBE_TARGET: target, ORCA_PROBE_NONCE: nonce }
          },
          5000
        )
        const timer = setTimeout(() => finish?.(), 7000)
        await completion
        clearTimeout(timer)
        assert.ok(
          output.includes(`ORCA_PROBE:${nonce}:${expected}`),
          `${name}: missing structured result`
        )
        await client.request('kill', { sessionId }, 3000).catch((error) => {
          if (!(error instanceof Error) || !error.message.startsWith('Session not found:'))
            throw error
        })
        const inventory = await client.request<any>('listSessions', undefined, 3000)
        console.log(
          JSON.stringify({
            name,
            daemonReadErrno: expected,
            appRead: await appRead(target),
            pid: created.pid,
            liveProbe: inventory.sessions.some((s: any) => s.sessionId === sessionId && s.isAlive),
            retainedProbe: inventory.sessions.some((s: any) => s.sessionId === sessionId)
          })
        )
      } finally {
        unsubscribe()
      }
    }
    const sessionId = `probe-stall-${randomUUID()}`
    const stalled = await client.request<any>(
      'createOrAttach',
      {
        sessionId,
        cols: 80,
        rows: 24,
        cwd: root,
        shellOverride: helper,
        env: { ORCA_PROBE_TARGET: unusual, ORCA_PROBE_NONCE: randomUUID(), ORCA_PROBE_STALL: '1' }
      },
      5000
    )
    await client.request('kill', { sessionId }, 3000)
    let gone = false
    for (let n = 0; n < 30; n++) {
      try {
        process.kill(stalled.pid, 0)
      } catch (error) {
        if (error instanceof Error && 'code' in error && error.code === 'ESRCH') gone = true
      }
      if (gone) break
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
    assert.ok(gone, 'owned stalled child did not exit')
    console.log(JSON.stringify({ name: 'stalled-child-cleanup', confirmedGone: gone }))
    const autonomous = await client.request<any>(
      'createOrAttach',
      {
        sessionId: `probe-alarm-${randomUUID()}`,
        cols: 80,
        rows: 24,
        cwd: root,
        shellOverride: helper,
        env: { ORCA_PROBE_TARGET: unusual, ORCA_PROBE_NONCE: randomUUID(), ORCA_PROBE_STALL: '1' }
      },
      5000
    )
    let autonomousGone = false
    for (let n = 0; n < 70; n++) {
      try {
        process.kill(autonomous.pid, 0)
      } catch (error) {
        if (error instanceof Error && 'code' in error && error.code === 'ESRCH')
          autonomousGone = true
      }
      if (autonomousGone) break
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
    assert.ok(autonomousGone, 'helper did not self-terminate without client kill')
    console.log(JSON.stringify({ name: 'self-deadline', confirmedGone: autonomousGone }))
  } finally {
    chmodSync(denied, 0o700)
    client.disconnect()
    if (host.connected) host.send('stop')
    const code = await exited
    console.log(JSON.stringify({ hostExitCode: code, fixtureRoot: root }))
  }
}

if (process.argv[2] === '--host') {
  void runHost(process.argv[3])
} else {
  void runParent(process.argv[2]).catch((error) => {
    console.error(error)
    process.exitCode = 1
  })
}
