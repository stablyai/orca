/**
 * Runs the generated POSIX commands through a real `/bin/sh`.
 *
 * The unit tests assert on command *text*, which is exactly the kind of test that stays
 * green while the shell it produces does not work — a quoting slip, a `case` pattern that
 * never matches, a `tar` invocation that silently captures nothing. These run the strings.
 */
import { execFileSync, spawn } from 'node:child_process'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  exportProfileStateJson,
  importProfileStateJson
} from '../persistence/profile-state/profile-state-documents'
import { openProfileStateDatabase } from '../persistence/profile-state/profile-state-database'

import {
  orcadLaunchCommand,
  orcadLivenessProbeCommand,
  ORCAD_PID_FILENAME,
  ORCAD_READINESS_FILENAME,
  parseOrcadLiveness,
  parseOrcadReadinessOutput
} from './orcad-remote-launch'
import {
  orcadStopFreedTheHost,
  parseOrcadStopOutcome,
  stopOrcadCommand
} from './orcad-remote-process-control'
import {
  captureOrcadStateSnapshotCommand,
  compareOrcadStateSnapshotCommand,
  newestStateMtimeCommand,
  orcadSnapshotIsUnchanged,
  parseNewestStateMtimeSeconds,
  parseOrcadSnapshotCapture,
  parseOrcadSnapshotRestore,
  probeOrcadStateSnapshotCommand,
  restoreOrcadStateSnapshotCommand
} from './orcad-state-snapshot'
import { getRemoteHostPlatform } from './ssh-remote-platform'

const host = getRemoteHostPlatform('linux-x64')
let root = ''
let dataDir = ''
let snapshotDir = ''
let versionDir = ''
const launchedPids = new Set<number>()

function sh(command: string): string {
  return execFileSync('/bin/sh', ['-c', command], { encoding: 'utf8' })
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'orcad-shell-'))
  dataDir = join(root, '.orca')
  snapshotDir = join(root, 'snapshots', 'pre-0.2.0+bb01-1000')
  versionDir = join(root, '.orca-remote', 'orcad-0.2.0+bb01')
  mkdirSync(join(dataDir, 'profiles', 'p1'), { recursive: true })
  mkdirSync(join(dataDir, 'daemon'), { recursive: true })
  mkdirSync(versionDir, { recursive: true })
  writeFileSync(join(dataDir, 'orca-profile-index.json'), '{"v":"before"}')
  writeFileSync(join(dataDir, 'profiles', 'p1', 'orca-data.json'), '{"repos":"before"}')
  writeFileSync(join(dataDir, 'daemon', 'daemon.sock.token'), 'live-daemon-token')
})

afterEach(() => {
  for (const pid of launchedPids) {
    try {
      process.kill(pid, 'SIGKILL')
    } catch {
      // Successful stops have already removed their test processes.
    }
  }
  launchedPids.clear()
  rmSync(root, { recursive: true, force: true })
})

async function launchTestRuntime(legacyWrapper = false): Promise<{
  runtimePid: number
  recordedPid: number
  terminatedFile: string
}> {
  const terminatedFile = join(versionDir, 'terminated')
  writeFileSync(
    join(versionDir, 'orcad.js'),
    [
      `process.on('SIGTERM', () => {`,
      `  require('node:fs').writeFileSync(${JSON.stringify(terminatedFile)}, 'terminated');`,
      `  process.exit(0);`,
      `});`,
      `console.log(JSON.stringify({type: 'orca_server_ready', health: {pid: process.pid}}));`,
      `setTimeout(() => process.exit(1), 10_000);`
    ].join('\n')
  )
  let command = orcadLaunchCommand(host, {
    remoteInstallDir: versionDir,
    nodePath: process.execPath,
    fullVersion: '0.2.0+bb01',
    userDataDir: dataDir,
    bindHost: '127.0.0.1',
    port: 0
  })
  if (legacyWrapper) {
    // The trailing command retains the old macOS waiting-shell behavior on every POSIX shell.
    command = command
      .replace('exec nohup ', 'nohup ')
      .replace('< /dev/null &', '< /dev/null && : &')
  }
  execFileSync('/bin/sh', ['-c', command], { stdio: 'ignore', timeout: 5_000 })
  const recordedPid = Number(readFileSync(join(versionDir, ORCAD_PID_FILENAME), 'utf8').trim())
  expect(recordedPid).toBeGreaterThan(1)
  launchedPids.add(recordedPid)
  const readRuntimePid = (): number => {
    const parsed = parseOrcadReadinessOutput(
      readFileSync(join(versionDir, ORCAD_READINESS_FILENAME), 'utf8')
    )
    return parsed.state === 'ready' ? (parsed.readiness.health?.pid ?? 0) : 0
  }
  await expect.poll(readRuntimePid, { timeout: 2_000, interval: 20 }).toBeGreaterThan(1)
  const runtimePid = readRuntimePid()
  launchedPids.add(runtimePid)
  return { runtimePid, recordedPid, terminatedFile }
}

function stopTestRuntime(justLaunched = false): ReturnType<typeof parseOrcadStopOutcome> {
  return parseOrcadStopOutcome(
    execFileSync(
      '/bin/sh',
      [
        '-c',
        stopOrcadCommand(host, versionDir, {
          waitSeconds: 3,
          ...(justLaunched ? { justLaunched: true as const } : { nodePath: process.execPath })
        })
      ],
      { encoding: 'utf8', timeout: 5_000 }
    )
  )
}

describe('state snapshot commands, run for real', () => {
  it('detects candidate SQLite migration without modifying current state or the snapshot', () => {
    sh(captureOrcadStateSnapshotCommand(host, dataDir, snapshotDir))
    const archive = readFileSync(join(snapshotDir, 'state.tar'))
    const compare = (): boolean =>
      orcadSnapshotIsUnchanged(sh(compareOrcadStateSnapshotCommand(host, dataDir, snapshotDir)))
    expect(compare()).toBe(true)
    writeFileSync(join(dataDir, 'daemon', 'daemon.sock.token'), 'live-daemon-after-launch')
    expect(compare()).toBe(true)

    const databasePath = join(dataDir, 'profiles', 'p1', 'profile-state.db')
    const candidate = openProfileStateDatabase(databasePath, 'p1')
    try {
      importProfileStateJson(candidate.db, '{"settings":{"theme":"dark"}}')
    } finally {
      candidate.db.close()
    }
    const databaseBytes = readFileSync(databasePath)

    expect(compare()).toBe(false)
    expect(readFileSync(databasePath)).toEqual(databaseBytes)
    expect(readFileSync(join(snapshotDir, 'state.tar'))).toEqual(archive)
    expect(readFileSync(join(dataDir, 'daemon', 'daemon.sock.token'), 'utf8')).toBe(
      'live-daemon-after-launch'
    )
  })

  it('requires an intact comparison snapshot before an older build can restart', () => {
    expect(
      orcadSnapshotIsUnchanged(sh(compareOrcadStateSnapshotCommand(host, dataDir, snapshotDir)))
    ).toBe(false)
    sh(captureOrcadStateSnapshotCommand(host, dataDir, snapshotDir))
    writeFileSync(join(snapshotDir, 'state.tar'), 'not an archive')
    expect(
      orcadSnapshotIsUnchanged(sh(compareOrcadStateSnapshotCommand(host, dataDir, snapshotDir)))
    ).toBe(false)
    expect(readFileSync(join(dataDir, 'profiles', 'p1', 'orca-data.json'), 'utf8')).toBe(
      '{"repos":"before"}'
    )
  })

  it('rejects symlinked profile state that a tar snapshot does not preserve', () => {
    const external = join(root, 'external-profile')
    mkdirSync(external)
    writeFileSync(join(external, 'orca-data.json'), '{"before":true}')
    const profile = join(dataDir, 'profiles', 'linked')
    symlinkSync(external, profile)

    expect(
      parseOrcadSnapshotCapture(sh(captureOrcadStateSnapshotCommand(host, dataDir, snapshotDir)))
    ).toBe('failed')

    mkdirSync(snapshotDir, { recursive: true })
    execFileSync('tar', ['-C', dataDir, '-cf', join(snapshotDir, 'state.tar'), 'profiles'])
    writeFileSync(join(external, 'orca-data.json'), '{"candidate":true}')
    expect(
      orcadSnapshotIsUnchanged(sh(compareOrcadStateSnapshotCommand(host, dataDir, snapshotDir)))
    ).toBe(false)
    expect(readFileSync(join(external, 'orca-data.json'), 'utf8')).toBe('{"candidate":true}')
  })

  it('captures, then restores state the newer build overwrote', () => {
    expect(
      parseOrcadSnapshotCapture(sh(captureOrcadStateSnapshotCommand(host, dataDir, snapshotDir)))
    ).toBe('captured')
    expect(sh(probeOrcadStateSnapshotCommand(host, snapshotDir)).trim()).toBe('PRESENT')

    // The new version migrates the store and adds a file of its own.
    writeFileSync(join(dataDir, 'orca-profile-index.json'), '{"v":"migrated"}')
    writeFileSync(join(dataDir, 'profiles', 'p1', 'new-build-only.json'), '{}')

    expect(
      parseOrcadSnapshotRestore(sh(restoreOrcadStateSnapshotCommand(host, dataDir, snapshotDir)))
    ).toBe('restored')
    expect(readFileSync(join(dataDir, 'orca-profile-index.json'), 'utf8')).toBe('{"v":"before"}')
    // Removed before extraction, so the older build never sees a file it cannot interpret.
    expect(() => readFileSync(join(dataDir, 'profiles', 'p1', 'new-build-only.json'))).toThrow()
  })

  it('round-trips a quiescent SQLite profile database with its WAL sidecars', () => {
    const profileDirectory = join(dataDir, 'profiles', 'p1')
    const databasePath = join(profileDirectory, 'profile-state.db')
    const opened = openProfileStateDatabase(databasePath, 'p1')
    try {
      importProfileStateJson(
        opened.db,
        JSON.stringify({ settings: { theme: 'dark' }, snapshotMarker: 'before' })
      )
      // The connection remains open, so WAL/SHM are still part of the archive boundary while
      // the generated command reads the now-quiescent files.
      expect(existsSync(`${databasePath}-wal`)).toBe(true)
      expect(
        parseOrcadSnapshotCapture(sh(captureOrcadStateSnapshotCommand(host, dataDir, snapshotDir)))
      ).toBe('captured')
    } finally {
      opened.db.close()
    }

    const changed = openProfileStateDatabase(databasePath, 'p1')
    try {
      importProfileStateJson(
        changed.db,
        JSON.stringify({ settings: { theme: 'light' }, snapshotMarker: 'after' })
      )
    } finally {
      changed.db.close()
    }
    expect(
      parseOrcadSnapshotRestore(sh(restoreOrcadStateSnapshotCommand(host, dataDir, snapshotDir)))
    ).toBe('restored')

    const restored = openProfileStateDatabase(databasePath, 'p1')
    try {
      expect(JSON.parse(exportProfileStateJson(restored.db))).toEqual({
        settings: { theme: 'dark' },
        snapshotMarker: 'before'
      })
    } finally {
      restored.db.close()
    }
  })

  it('leaves the live daemon runtime dir untouched through capture and restore', () => {
    sh(captureOrcadStateSnapshotCommand(host, dataDir, snapshotDir))
    // The daemon is running across the rollback and rewrites its token; a restore that
    // reached <root>/daemon would break the fence that keeps its terminals adoptable.
    writeFileSync(join(dataDir, 'daemon', 'daemon.sock.token'), 'token-after-restart')
    sh(restoreOrcadStateSnapshotCommand(host, dataDir, snapshotDir))
    expect(readFileSync(join(dataDir, 'daemon', 'daemon.sock.token'), 'utf8')).toBe(
      'token-after-restart'
    )
  })

  it('reports EMPTY on a data root with nothing to lose, instead of an archive of nothing', () => {
    const emptyRoot = join(root, 'fresh')
    mkdirSync(emptyRoot)
    expect(
      parseOrcadSnapshotCapture(sh(captureOrcadStateSnapshotCommand(host, emptyRoot, snapshotDir)))
    ).toBe('empty')
    expect(sh(probeOrcadStateSnapshotCommand(host, snapshotDir)).trim()).toBe('ABSENT')
  })

  it('reports MISSING rather than claiming a restore it did not perform', () => {
    expect(
      parseOrcadSnapshotRestore(
        sh(restoreOrcadStateSnapshotCommand(host, dataDir, join(root, 'nope')))
      )
    ).toBe('missing')
  })

  it('reads a real mtime for the store', () => {
    const seconds = parseNewestStateMtimeSeconds(sh(newestStateMtimeCommand(host, dataDir)))
    expect(seconds).toBeGreaterThan(1_600_000_000)
    expect(seconds).toBeLessThanOrEqual(Math.floor(Date.now() / 1000) + 5)
  })

  it('survives a data root whose path contains a quote and a space', () => {
    const nasty = join(root, `it's a dir`)
    mkdirSync(join(nasty, 'profiles'), { recursive: true })
    writeFileSync(join(nasty, 'orca-profile-index.json'), '{"v":"quoted"}')
    expect(
      parseOrcadSnapshotCapture(sh(captureOrcadStateSnapshotCommand(host, nasty, snapshotDir)))
    ).toBe('captured')
    expect(
      orcadSnapshotIsUnchanged(sh(compareOrcadStateSnapshotCommand(host, nasty, snapshotDir)))
    ).toBe(true)
    writeFileSync(join(nasty, 'orca-profile-index.json'), '{"v":"changed"}')
    expect(
      orcadSnapshotIsUnchanged(sh(compareOrcadStateSnapshotCommand(host, nasty, snapshotDir)))
    ).toBe(false)
    expect(
      parseOrcadSnapshotRestore(sh(restoreOrcadStateSnapshotCommand(host, nasty, snapshotDir)))
    ).toBe('restored')
    expect(readFileSync(join(nasty, 'orca-profile-index.json'), 'utf8')).toBe('{"v":"quoted"}')
  })
})

describe('liveness and stop commands, run for real', () => {
  it('records the runtime PID and waits for that runtime to exit when stopped', async () => {
    const { runtimePid, recordedPid, terminatedFile } = await launchTestRuntime()
    expect(recordedPid).toBe(runtimePid)
    expect(stopTestRuntime()).toBe('stopped')
    expect(readFileSync(terminatedFile, 'utf8')).toBe('terminated')
    // An unreaped zombie has exited even though kill -0 still succeeds.
    expect(sh(`ps -o stat= -p ${runtimePid} || true`).trim()).toMatch(/^(?:Z.*)?$/)
    expect(existsSync(join(versionDir, ORCAD_PID_FILENAME))).toBe(true)
    expect(stopTestRuntime()).toBe('already-exited')
  })

  it('refuses a legacy wrapper PID both before and after its shell exits', async () => {
    const { runtimePid, recordedPid, terminatedFile } = await launchTestRuntime(true)
    expect(recordedPid).not.toBe(runtimePid)
    const beforeWrapperExit = stopTestRuntime()
    expect(beforeWrapperExit).toBe('unknown')
    expect(orcadStopFreedTheHost(beforeWrapperExit)).toBe(false)
    expect(() => process.kill(recordedPid, 0)).not.toThrow()
    expect(() => process.kill(runtimePid, 0)).not.toThrow()

    process.kill(recordedPid, 'SIGTERM')
    await expect
      .poll(() => sh(`ps -o stat= -p ${recordedPid} || true`).trim(), { timeout: 2_000 })
      .toMatch(/^(?:Z.*)?$/)
    const afterWrapperExit = stopTestRuntime()
    expect(afterWrapperExit).toBe('unknown')
    expect(orcadStopFreedTheHost(afterWrapperExit)).toBe(false)
    expect(() => process.kill(runtimePid, 0)).not.toThrow()
    expect(existsSync(terminatedFile)).toBe(false)
  })

  it.each(['missing', 'malformed', 'without-health'])(
    'refuses an incumbent with %s readiness proof',
    async (proof) => {
      const { runtimePid, terminatedFile } = await launchTestRuntime()
      const readinessFile = join(versionDir, ORCAD_READINESS_FILENAME)
      if (proof === 'missing') {
        rmSync(readinessFile)
      } else {
        writeFileSync(readinessFile, proof === 'malformed' ? '{' : '{"type":"orca_server_ready"}')
      }
      expect(stopTestRuntime()).toBe('unknown')
      expect(() => process.kill(runtimePid, 0)).not.toThrow()
      expect(existsSync(terminatedFile)).toBe(false)
    }
  )

  it('can stop a candidate just launched with exec without readiness', async () => {
    const { runtimePid, recordedPid, terminatedFile } = await launchTestRuntime()
    expect(recordedPid).toBe(runtimePid)
    rmSync(join(versionDir, ORCAD_READINESS_FILENAME))
    expect(stopTestRuntime(true)).toBe('stopped')
    expect(readFileSync(terminatedFile, 'utf8')).toBe('terminated')
    expect(sh(`ps -o stat= -p ${runtimePid} || true`).trim()).toMatch(/^(?:Z.*)?$/)
  })

  it.each(['before', 'after'])('refuses a permission-denied probe %s SIGTERM', async (phase) => {
    const { runtimePid, terminatedFile } = await launchTestRuntime()
    const deniedProbe = [
      'term_sent=0; kill() {',
      'if [ "$1" = -TERM ]; then term_sent=1; return 0; fi;',
      `if [ '${phase}' = before ] || [ "$term_sent" = 1 ]; then`,
      'echo "kill: Operation not permitted" >&2; return 1; fi;',
      'command kill "$@"; };'
    ].join(' ')
    const outcome = parseOrcadStopOutcome(
      sh(
        `${deniedProbe} ${stopOrcadCommand(host, versionDir, {
          waitSeconds: 1,
          nodePath: process.execPath
        })}`
      )
    )
    expect(outcome).toBe('unknown')
    expect(orcadStopFreedTheHost(outcome)).toBe(false)
    expect(() => process.kill(runtimePid, 0)).not.toThrow()
    expect(existsSync(terminatedFile)).toBe(false)
  })

  it('reports UNKNOWN with no pid file, and DEAD for a pid that has exited', () => {
    expect(parseOrcadLiveness(sh(orcadLivenessProbeCommand(host, versionDir)))).toBe('UNKNOWN')
    writeFileSync(join(versionDir, ORCAD_PID_FILENAME), 'not-a-pid')
    expect(parseOrcadLiveness(sh(orcadLivenessProbeCommand(host, versionDir)))).toBe('UNKNOWN')
    // A pid that has certainly exited: our own `sh` child from the line above.
    const exited = Number(sh('sh -c "echo $$"').trim())
    writeFileSync(join(versionDir, ORCAD_PID_FILENAME), String(exited))
    expect(parseOrcadLiveness(sh(orcadLivenessProbeCommand(host, versionDir)))).toBe('DEAD')
  })

  it('reports LIVE for a running process and stops it with SIGTERM', async () => {
    const child = spawn('/bin/sh', ['-c', 'sleep 30'], { stdio: 'ignore' })
    try {
      writeFileSync(join(versionDir, ORCAD_PID_FILENAME), String(child.pid))
      expect(parseOrcadLiveness(sh(orcadLivenessProbeCommand(host, versionDir)))).toBe('LIVE')

      const exited = new Promise<NodeJS.Signals | null>((resolve) =>
        child.once('exit', (_code, signal) => resolve(signal))
      )
      expect(
        parseOrcadStopOutcome(
          sh(stopOrcadCommand(host, versionDir, { waitSeconds: 10, justLaunched: true }))
        )
      ).toBe('stopped')
      expect(await exited).toBe('SIGTERM')
      expect(parseOrcadLiveness(sh(orcadLivenessProbeCommand(host, versionDir)))).toBe('DEAD')
    } finally {
      child.kill('SIGKILL')
    }
  })

  // `kill -0` succeeds on a zombie, so a probe built on it alone calls an exited process
  // live: the stop loop would time out on a process that is already gone, and GC would keep
  // a dead version dir forever. Verified as a real macOS behaviour, not a hypothetical.
  it('reports a zombie as DEAD, not as a running process', () => {
    const child = spawn('/bin/sh', ['-c', 'exit 0'], { stdio: 'ignore' })
    try {
      writeFileSync(join(versionDir, ORCAD_PID_FILENAME), String(child.pid))
      // Block the event loop so Node never reaps it; the process is now a zombie.
      sh('sleep 1')
      expect(sh(`ps -o stat= -p ${child.pid} || echo GONE`).trim()).toMatch(/^Z/)
      expect(sh(`kill -0 ${child.pid} 2>/dev/null && echo LIVE || echo DEAD`).trim()).toBe('LIVE')
      expect(parseOrcadLiveness(sh(orcadLivenessProbeCommand(host, versionDir)))).toBe('DEAD')
      expect(
        parseOrcadStopOutcome(
          sh(stopOrcadCommand(host, versionDir, { waitSeconds: 1, justLaunched: true }))
        )
      ).toBe('already-exited')
    } finally {
      child.unref()
    }
  })

  it('reports ALREADY_EXITED for a stale pid file rather than signalling a stranger', () => {
    const exited = Number(sh('sh -c "echo $$"').trim())
    writeFileSync(join(versionDir, ORCAD_PID_FILENAME), String(exited))
    expect(
      parseOrcadStopOutcome(
        sh(stopOrcadCommand(host, versionDir, { waitSeconds: 1, justLaunched: true }))
      )
    ).toBe('already-exited')
  })

  it('reports NO_PID when the version dir was never launched', () => {
    expect(
      parseOrcadStopOutcome(
        sh(stopOrcadCommand(host, versionDir, { waitSeconds: 1, nodePath: process.execPath }))
      )
    ).toBe('no-pid')
  })
})
