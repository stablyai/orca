/* eslint-disable max-lines -- Why: pinning every layer that should have
   caught the original "node-pty not available" bug (chained shell, package
   ordering, probe shape, channel-failure surfacing, .bashrc-noise immunity,
   platform-tagged logs) requires keeping these scenarios in one file so the
   shared mock connection and exec-response fixture stay aligned. */
// Why: regression coverage for the install-probe contract. The original
// "node-pty is not available" bug shipped because every layer that should
// have caught it (chained shell, swallowing catch, dir-only probe) was
// silent. Tests below pin the parts that, individually, would have caught
// it.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({
  app: { getAppPath: () => '/mock/app' }
}))

vi.mock('fs', () => ({
  existsSync: vi.fn().mockReturnValue(true),
  readFileSync: vi.fn().mockReturnValue('0.1.0+testhash')
}))

vi.mock('./relay-protocol', () => ({
  RELAY_VERSION: '0.1.0',
  RELAY_REMOTE_DIR: '.orca-remote',
  parseUnameToRelayPlatform: vi.fn().mockReturnValue('linux-x64'),
  RELAY_SENTINEL: 'ORCA-RELAY v0.1.0 READY\n',
  RELAY_SENTINEL_TIMEOUT_MS: 10_000
}))

vi.mock('./ssh-relay-deploy-helpers', () => ({
  uploadDirectory: vi.fn().mockResolvedValue(undefined),
  waitForSentinel: vi.fn().mockResolvedValue({
    write: vi.fn(),
    onData: vi.fn(),
    onClose: vi.fn()
  }),
  execCommand: vi.fn(),
  resolveRemoteNodePath: vi.fn().mockResolvedValue('/usr/bin/node')
}))

vi.mock('./ssh-relay-versioned-install', () => ({
  readLocalFullVersion: vi.fn().mockReturnValue('0.1.0+testhash'),
  computeRemoteRelayDir: (home: string, v: string) => `${home}/.orca-remote/relay-${v}`,
  isRelayAlreadyInstalled: vi.fn().mockResolvedValue(false),
  acquireInstallLock: vi.fn().mockResolvedValue(undefined),
  finalizeInstall: vi.fn().mockResolvedValue(undefined),
  abandonInstall: vi.fn().mockResolvedValue(undefined),
  gcOldRelayVersions: vi.fn().mockResolvedValue(undefined)
}))

vi.mock('./ssh-connection-utils', () => ({
  shellEscape: (s: string) => `'${s}'`
}))

import { deployAndLaunchRelay } from './ssh-relay-deploy'
import { execCommand } from './ssh-relay-deploy-helpers'
import { parseUnameToRelayPlatform } from './relay-protocol'
import {
  acquireInstallLock,
  abandonInstall,
  finalizeInstall,
  isRelayAlreadyInstalled
} from './ssh-relay-versioned-install'
import type { SshConnection } from './ssh-connection'

type SftpWriteCapture = {
  paths: string[]
  contents: Record<string, string>
  // Number of execCommand calls observed at the moment ws.end() ran for each
  // captured path. Used to pin "package.json was written before npm install".
  execCallCountAtWrite: Record<string, number>
}

function makeMockConnection(capture: SftpWriteCapture): SshConnection {
  const sftpCreate = (): unknown => ({
    mkdir: vi.fn((_p: string, cb: (err: Error | null) => void) => cb(null)),
    on: vi.fn(),
    once: vi.fn(),
    createWriteStream: vi.fn().mockImplementation((path: string) => {
      capture.paths.push(path)
      let buf = ''
      let closeCb: (() => void) | undefined
      const stub = {
        on: vi.fn((event: string, cb: () => void) => {
          if (event === 'close') {
            closeCb = cb
          }
        }),
        end: vi.fn((data?: string) => {
          if (typeof data === 'string') {
            buf += data
          }
          capture.contents[path] = buf
          capture.execCallCountAtWrite[path] = vi.mocked(execCommand).mock.calls.length
          if (closeCb) {
            setTimeout(closeCb, 0)
          }
        })
      }
      // Why: production code uses ws.once('close', ...). The 'once' wrapper
      // delegates to the same handler-table as 'on' for the test mock.
      return Object.assign(stub, { once: stub.on })
    }),
    end: vi.fn()
  })
  return {
    exec: vi.fn().mockResolvedValue({
      on: vi.fn(),
      stderr: { on: vi.fn() },
      stdin: {},
      stdout: { on: vi.fn() },
      close: vi.fn()
    }),
    sftp: vi.fn().mockImplementation(() => Promise.resolve(sftpCreate()))
  } as unknown as SshConnection
}

type ExecResponse = string | { reject: string }

// Exec call order under our mocks (deploy happy path):
//   1: uname              2: $HOME            3: mkdir remoteDir (uploadRelay)
//   4: chmod +x node      5: npm install      6: chmod prebuilds
//   7: probe (cd && node -e require)
//   [8: cat stderr — only when probe stdout is MISSING (graceful path)]
//   8 or 9: rm probe-stderr (best-effort cleanup; runs whenever probe resolved)
//   next: socket DEAD     next: socket READY
//
// When the probe rejects (SSH channel close or cd-failure when the install
// dir vanished), the catch path skips both stderr-capture and the rm.
function makeExecResponses(opts: {
  npmInstall: 'ok' | { reject: string }
  // 'ok'      : probe resolves with the sentinel; rm runs once
  // 'missing' : probe resolves with 'MISSING'; cat stderr + rm both run
  // 'dir-gone': probe rejects (cd-failure), exec rejects directly
  // { reject }: probe rejects with custom error (e.g. SSH channel)
  probe: 'ok' | 'missing' | 'dir-gone' | { reject: string }
  // Override probe stdout for shell-noise pressure tests. If set, replaces
  // the load-test stdout entirely (useful for testing pollution prefixes).
  probeStdoutOverride?: string
}): ExecResponse[] {
  const probeSlot: ExecResponse =
    opts.probeStdoutOverride !== undefined
      ? opts.probeStdoutOverride
      : opts.probe === 'ok'
        ? 'ORCA-NPTY-PROBE-OK\n'
        : opts.probe === 'missing'
          ? 'MISSING\n' // shell-level `|| echo MISSING` after require throw
          : opts.probe === 'dir-gone'
            ? { reject: 'cd: no such file or directory' }
            : opts.probe
  const slots: ExecResponse[] = [
    'Linux x86_64',
    '/home/u',
    '', // mkdir remoteDir (uploadRelay)
    '', // chmod +x node
    opts.npmInstall === 'ok' ? '' : opts.npmInstall,
    '', // chmod prebuilds
    probeSlot
  ]
  // Cleanup execs only run when the probe resolved (not when it rejected).
  const probeResolved = typeof probeSlot === 'string'
  if (probeResolved) {
    const probeOk = probeSlot.includes('ORCA-NPTY-PROBE-OK')
    if (!probeOk) {
      slots.push('') // cat stderr (graceful failure path captures detail)
    }
    slots.push('') // rm -f stderr (best-effort cleanup)
  }
  slots.push('DEAD', 'READY')
  return slots
}

describe('installNativeDeps (via deployAndLaunchRelay)', () => {
  let warnSpy: ReturnType<typeof vi.spyOn>
  const sftpCapture: SftpWriteCapture = {
    paths: [],
    contents: {},
    execCallCountAtWrite: {}
  }

  beforeEach(() => {
    vi.clearAllMocks()
    // Tests that throw mid-deploy leave unconsumed `mockResolvedValueOnce`
    // entries queued. Without resetting, the next test's first await consumes
    // a leaked response. clearAllMocks doesn't drop the queue (it only clears
    // .mock.calls), so we explicitly mockReset.
    vi.mocked(execCommand).mockReset()
    sftpCapture.paths.length = 0
    for (const k of Object.keys(sftpCapture.contents)) {
      delete sftpCapture.contents[k]
    }
    for (const k of Object.keys(sftpCapture.execCallCountAtWrite)) {
      delete sftpCapture.execCallCountAtWrite[k]
    }
    // Re-prime: factory mockReturnValue / mockResolvedValue survive
    // clearAllMocks, so this is just defense-in-depth in case a test does its
    // own resetAllMocks.
    vi.mocked(parseUnameToRelayPlatform).mockReturnValue('linux-x64')
    vi.mocked(isRelayAlreadyInstalled).mockResolvedValue(false)
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
  })

  afterEach(() => {
    warnSpy.mockRestore()
  })

  function feed(execResponses: ExecResponse[]): void {
    const mockExec = vi.mocked(execCommand)
    for (const r of execResponses) {
      if (typeof r === 'string') {
        mockExec.mockResolvedValueOnce(r)
      } else {
        mockExec.mockRejectedValueOnce(new Error(r.reject))
      }
    }
  }

  it('writes a hardcoded package.json BEFORE running npm install', async () => {
    const conn = makeMockConnection(sftpCapture)
    feed(makeExecResponses({ npmInstall: 'ok', probe: 'ok' }))

    await deployAndLaunchRelay(conn)

    const pkgPath = sftpCapture.paths.find((p) => p.endsWith('/package.json'))
    expect(pkgPath, 'package.json must be written via SFTP').toBeTruthy()

    const written = sftpCapture.contents[pkgPath as string]
    expect(written).toBeTruthy()
    const parsed = JSON.parse(written) as Record<string, unknown>
    expect(parsed.name).toBe('orca-relay')
    expect(parsed.version).toBe('1.0.0')
    expect(parsed.private).toBe(true)
    // Why: pin commonjs so a future Node default flip doesn't silently
    // break `require('node-pty')`.
    expect(parsed.type).toBe('commonjs')
    expect(parsed.dependencies).toEqual({ '@parcel/watcher': '2.5.6', 'node-pty': '1.1.0' })

    const execCalls = vi.mocked(execCommand).mock.calls.map(([, c]) => c)
    const npmInstallIdx = execCalls.findIndex(
      (c) => c.includes('npm install') && c.includes('node-pty') && c.includes('@parcel/watcher')
    )
    expect(npmInstallIdx).toBeGreaterThanOrEqual(0)
    // Pin actual ordering: number of execCommand calls observed at the moment
    // ws.end() ran for package.json must be < the index of `npm install`.
    // Catches a future refactor that fires SFTP-write and npm install via
    // Promise.all (where the final-state assertions above would still pass).
    const writeObservedAt = sftpCapture.execCallCountAtWrite[pkgPath as string]
    expect(writeObservedAt).toBeLessThanOrEqual(npmInstallIdx)
  })

  it('propagates a hard `npm install` failure so the deploy aborts before finalizeInstall', async () => {
    const conn = makeMockConnection(sftpCapture)
    feed(
      makeExecResponses({
        npmInstall: { reject: 'npm ERR! E404 Not Found node-pty' },
        probe: 'ok'
      })
    )

    await expect(deployAndLaunchRelay(conn)).rejects.toThrow(/npm ERR/)

    // The crucial regression: `.install-complete` must NOT have been written.
    // Previously the catch swallowed the throw and finalizeInstall ran anyway.
    expect(vi.mocked(finalizeInstall)).not.toHaveBeenCalled()

    const warnMessages = warnSpy.mock.calls.map((args) => String(args[0] ?? ''))
    expect(warnMessages.some((m) => m.includes('[ssh-relay][NATIVE-DEPS-INSTALL-FAIL]'))).toBe(true)
  })

  it('warns clearly when node-pty installs but require() fails (built-but-unloadable)', async () => {
    const conn = makeMockConnection(sftpCapture)
    feed(makeExecResponses({ npmInstall: 'ok', probe: 'missing' }))

    await deployAndLaunchRelay(conn)

    // Probe failure is non-fatal by design (see docs/ssh-relay-versioned-
    // install-dirs.md): relay still serves fs/git/preflight, only pty.spawn
    // fails at runtime. Throwing here would loop reconnects forever on
    // hosts where node-pty truly cannot build (Alpine without compiler,
    // glibc too old).
    const warnMessages = warnSpy.mock.calls.map((args) => String(args[0] ?? ''))
    expect(warnMessages.some((m) => m.includes('[ssh-relay][NPTY-MISSING]'))).toBe(true)

    expect(vi.mocked(finalizeInstall)).toHaveBeenCalledTimes(1)
    expect(vi.mocked(abandonInstall)).not.toHaveBeenCalled()
  })

  it('lets a probe SSH-channel failure bubble up rather than silently mapping to MISSING', async () => {
    const conn = makeMockConnection(sftpCapture)
    feed(
      makeExecResponses({
        npmInstall: 'ok',
        probe: { reject: 'SSH channel closed unexpectedly' }
      })
    )

    await expect(deployAndLaunchRelay(conn)).rejects.toThrow(/SSH channel/)

    // Pin that the rejection actually came from the PROBE call (not some
    // earlier/later exec). Drift in slot ordering would otherwise let this
    // test pass while exercising a different failure path.
    const execCalls = vi.mocked(execCommand).mock.calls.map(([, c]) => c)
    const probeCallIdx = execCalls.findIndex((c) => c.includes('require("node-pty")'))
    const npmInstallIdx = execCalls.findIndex(
      (c) => c.includes('npm install') && c.includes('node-pty') && c.includes('@parcel/watcher')
    )
    expect(probeCallIdx, 'probe must have been invoked').toBeGreaterThanOrEqual(0)
    // Probe must come strictly AFTER `npm install` — otherwise we'd be
    // probing into an empty install dir and this whole failure mode
    // wouldn't represent the real-world race.
    expect(probeCallIdx).toBeGreaterThan(npmInstallIdx)

    const warnMessages = warnSpy.mock.calls.map((args) => String(args[0] ?? ''))
    // Channel failure must NOT be conflated with "node-pty missing" or with
    // "npm install failed".
    expect(warnMessages.some((m) => m.includes('[ssh-relay][NPTY-MISSING]'))).toBe(false)
    expect(warnMessages.some((m) => m.includes('[ssh-relay][NATIVE-DEPS-INSTALL-FAIL]'))).toBe(
      false
    )

    expect(vi.mocked(finalizeInstall)).not.toHaveBeenCalled()
    // Lock must be released so a future reconnect can retry.
    expect(vi.mocked(abandonInstall)).toHaveBeenCalledTimes(1)
  })

  it('throws (rather than warns MISSING) when the install dir vanishes between npm install and probe', async () => {
    const conn = makeMockConnection(sftpCapture)
    feed(makeExecResponses({ npmInstall: 'ok', probe: 'dir-gone' }))

    // The probe shape `cd ${dir} && (node -e ... || echo MISSING)` short-
    // circuits on cd-failure (`&&`), so the whole exec rejects rather than
    // resolving with the MISSING sentinel. Conflating "dir vanished" with
    // "node-pty missing" would mark the version installed and strand the
    // user in degraded mode forever.
    await expect(deployAndLaunchRelay(conn)).rejects.toThrow(/cd:/)

    // Pin that the rejection came from the probe slot specifically, not
    // some earlier exec — otherwise a future refactor could move probe
    // before npm install and this test would still pass for the wrong
    // reason.
    const execCalls = vi.mocked(execCommand).mock.calls.map(([, c]) => c)
    const probeIdx = execCalls.findIndex((c) => c.includes('require("node-pty")'))
    const npmInstallIdx = execCalls.findIndex(
      (c) => c.includes('npm install') && c.includes('node-pty') && c.includes('@parcel/watcher')
    )
    expect(probeIdx).toBeGreaterThan(npmInstallIdx)

    const warnMessages = warnSpy.mock.calls.map((args) => String(args[0] ?? ''))
    expect(warnMessages.some((m) => m.includes('[ssh-relay][NPTY-MISSING]'))).toBe(false)

    expect(vi.mocked(finalizeInstall)).not.toHaveBeenCalled()
    expect(vi.mocked(abandonInstall)).toHaveBeenCalledTimes(1)
  })

  it('uses `node -e require()` rather than `test -d` so unloadable installs are caught', async () => {
    const conn = makeMockConnection(sftpCapture)
    feed(makeExecResponses({ npmInstall: 'ok', probe: 'ok' }))

    await deployAndLaunchRelay(conn)

    const probeCmds = vi
      .mocked(execCommand)
      .mock.calls.map(([, c]) => c)
      .filter((c) => c.includes(`require("node-pty")`))

    // Why: the probe shape must invoke the deployed node binary against
    // require('node-pty'). A weaker probe (test -d) could pass even when
    // the native binding load is broken.
    expect(probeCmds.length).toBeGreaterThan(0)
    expect(probeCmds[0]).toMatch(/node['"]?\s+-e/)

    // Pin the full installNativeDeps exec sequence: npm install → chmod
    // prebuilds → probe. A refactor that moves chmod-prebuilds after the
    // probe would silently break spawn-helper bits; one that probes before
    // npm install would test an empty dir.
    const all = vi.mocked(execCommand).mock.calls.map(([, c]) => c)
    const npmIdx = all.findIndex(
      (c) => c.includes('npm install') && c.includes('node-pty') && c.includes('@parcel/watcher')
    )
    const chmodPrebuildsIdx = all.findIndex(
      (c) => c.includes('spawn-helper') && c.includes('chmod +x')
    )
    const probeIdx = all.findIndex((c) => c.includes('require("node-pty")'))
    expect(npmIdx).toBeGreaterThanOrEqual(0)
    expect(chmodPrebuildsIdx).toBeGreaterThan(npmIdx)
    expect(probeIdx).toBeGreaterThan(chmodPrebuildsIdx)

    // Happy path: finalize exactly once, abandon never.
    expect(vi.mocked(finalizeInstall)).toHaveBeenCalledTimes(1)
    expect(vi.mocked(abandonInstall)).not.toHaveBeenCalled()
  })

  it('matches the sentinel even with bashrc/MOTD noise prefixed to probe stdout', async () => {
    const conn = makeMockConnection(sftpCapture)
    // Some remotes have customized .bashrc that prints to stdout on every
    // non-interactive shell exec (corporate MOTD, NVM/conda init banners).
    // Production uses .includes(PROBE_OK) with stderr redirected to a file,
    // so noise on stdout BEFORE the sentinel must still resolve to OK.
    feed(
      makeExecResponses({
        npmInstall: 'ok',
        probe: 'ok',
        probeStdoutOverride: 'Welcome to Acme Corp\nLast login: ...\nORCA-NPTY-PROBE-OK\n'
      })
    )

    await deployAndLaunchRelay(conn)

    const warnMessages = warnSpy.mock.calls.map((args) => String(args[0] ?? ''))
    expect(warnMessages.some((m) => m.includes('[ssh-relay][NPTY-MISSING]'))).toBe(false)
    expect(vi.mocked(finalizeInstall)).toHaveBeenCalledTimes(1)
  })

  it('detects MISSING even when the shell prepends noise before the MISSING token', async () => {
    const conn = makeMockConnection(sftpCapture)
    feed(
      makeExecResponses({
        npmInstall: 'ok',
        probe: 'missing',
        probeStdoutOverride: '(node:1234) [DEP0040] DeprecationWarning: ...\nMISSING\n'
      })
    )

    await deployAndLaunchRelay(conn)

    // Absence of PROBE_OK is what triggers the warn, regardless of what
    // appears around it. finalize still runs (degraded-mode by design).
    const warnMessages = warnSpy.mock.calls.map((args) => String(args[0] ?? ''))
    expect(warnMessages.some((m) => m.includes('[ssh-relay][NPTY-MISSING]'))).toBe(true)
    expect(vi.mocked(finalizeInstall)).toHaveBeenCalledTimes(1)
    expect(vi.mocked(abandonInstall)).not.toHaveBeenCalled()
  })

  it('includes the platform tuple in NPTY-MISSING and native install failure logs', async () => {
    // Platform tuple lets bug reports be triaged for prebuild availability
    // without asking the user to dig out their arch.
    const conn = makeMockConnection(sftpCapture)
    feed(makeExecResponses({ npmInstall: 'ok', probe: 'missing' }))
    await deployAndLaunchRelay(conn)
    const missingMsgs = warnSpy.mock.calls
      .map((args) => String(args[0] ?? ''))
      .filter((m) => m.includes('[ssh-relay][NPTY-MISSING]'))
    expect(missingMsgs.length).toBeGreaterThan(0)
    expect(missingMsgs[0]).toContain('linux-x64')
  })

  it('writes an idempotent package.json (same bytes on every install)', async () => {
    // First install run.
    const conn1 = makeMockConnection(sftpCapture)
    feed(makeExecResponses({ npmInstall: 'ok', probe: 'ok' }))
    await deployAndLaunchRelay(conn1)
    const firstPath = sftpCapture.paths.find((p) => p.endsWith('/package.json')) as string
    const first = sftpCapture.contents[firstPath]

    // Reset capture, run again as if it were a fresh install of the same dir.
    sftpCapture.paths.length = 0
    for (const k of Object.keys(sftpCapture.contents)) {
      delete sftpCapture.contents[k]
    }
    for (const k of Object.keys(sftpCapture.execCallCountAtWrite)) {
      delete sftpCapture.execCallCountAtWrite[k]
    }
    vi.mocked(execCommand).mockReset()

    const conn2 = makeMockConnection(sftpCapture)
    feed(makeExecResponses({ npmInstall: 'ok', probe: 'ok' }))
    await deployAndLaunchRelay(conn2)
    const secondPath = sftpCapture.paths.find((p) => p.endsWith('/package.json')) as string
    const second = sftpCapture.contents[secondPath]

    expect(second).toBe(first)
  })

  it('repairs an existing complete relay dir that is missing @parcel/watcher', async () => {
    vi.mocked(isRelayAlreadyInstalled).mockResolvedValue(true)
    const conn = makeMockConnection(sftpCapture)
    feed([
      'Linux x86_64',
      '/home/u',
      'MISSING', // first native-deps probe before lock
      'MISSING', // re-probe after lock
      '', // npm install native deps
      '', // chmod prebuilds
      'ORCA-NPTY-PROBE-OK\n',
      '', // rm probe stderr
      'DEAD',
      'READY'
    ])

    await deployAndLaunchRelay(conn)

    expect(vi.mocked(acquireInstallLock)).toHaveBeenCalledTimes(1)
    expect(vi.mocked(finalizeInstall)).toHaveBeenCalledTimes(1)
    const execCalls = vi.mocked(execCommand).mock.calls.map(([, c]) => c)
    expect(
      execCalls.some(
        (c) => c.includes('npm install') && c.includes('node-pty') && c.includes('@parcel/watcher')
      )
    ).toBe(true)
  })

  it('does not mutate an existing relay dir when required native deps are present', async () => {
    vi.mocked(isRelayAlreadyInstalled).mockResolvedValue(true)
    const conn = makeMockConnection(sftpCapture)
    feed(['Linux x86_64', '/home/u', 'ORCA-NATIVE-DEPS-OK', 'DEAD', 'READY'])

    await deployAndLaunchRelay(conn)

    expect(vi.mocked(acquireInstallLock)).not.toHaveBeenCalled()
    expect(vi.mocked(finalizeInstall)).not.toHaveBeenCalled()
    const execCalls = vi.mocked(execCommand).mock.calls.map(([, c]) => c)
    expect(execCalls.some((c) => c.includes('npm install'))).toBe(false)
  })
})
