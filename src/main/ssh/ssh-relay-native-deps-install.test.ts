// Why: regression coverage for the install-probe contract. The original
// "node-pty is not available" bug shipped because every layer that should
// have caught it (chained shell, swallowing catch, resolve-only probe) was
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
  isUnconfirmedSshCommandTermination: (error: unknown) =>
    error instanceof Error &&
    (error as Error & { sshChannelCloseConfirmed?: boolean }).sshChannelCloseConfirmed === false,
  execCommand: vi.fn()
}))

vi.mock('./ssh-remote-node-resolution', () => ({
  resolveRemoteNodePath: vi.fn().mockResolvedValue('/usr/bin/node')
}))

vi.mock('./ssh-relay-versioned-install', () => ({
  readLocalFullVersion: vi.fn().mockReturnValue('0.1.0+testhash'),
  computeRemoteRelayDir: (home: string, v: string) => `${home}/.orca-remote/relay-${v}`,
  isRelayAlreadyInstalled: vi.fn().mockResolvedValue(false),
  finalizeInstall: vi.fn().mockResolvedValue(undefined),
  abandonInstall: vi.fn().mockResolvedValue(undefined),
  gcOldRelayVersions: vi.fn().mockResolvedValue(undefined)
}))

vi.mock('./ssh-relay-install-lock', () => ({
  acquireInstallLock: vi.fn().mockResolvedValue(undefined)
}))

vi.mock('./ssh-relay-repair-lock', () => ({
  tryAcquireRelayRepairLock: vi.fn().mockResolvedValue('acquired')
}))

vi.mock('./ssh-relay-gc-claim', () => ({
  releaseRelayGcClaimWithRetry: vi.fn().mockResolvedValue('released'),
  tryAcquireRelayGcClaim: vi.fn().mockResolvedValue('launch-token'),
  waitForRelayGcClaimRelease: vi.fn().mockResolvedValue(undefined)
}))

vi.mock('./ssh-connection-utils', () => ({
  shellEscape: (s: string) => `'${s}'`
}))

import { deployAndLaunchRelay } from './ssh-relay-deploy'
import { execCommand, uploadDirectory } from './ssh-relay-deploy-helpers'
import { RELAY_DEPLOY_TIMEOUT_MS } from './ssh-relay-deploy-timing'
import { parseUnameToRelayPlatform } from './relay-protocol'
import { resolveRemoteNodePath } from './ssh-remote-node-resolution'
import {
  abandonInstall,
  finalizeInstall,
  isRelayAlreadyInstalled
} from './ssh-relay-versioned-install'
import { acquireInstallLock } from './ssh-relay-install-lock'
import { tryAcquireRelayRepairLock } from './ssh-relay-repair-lock'
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
    canRunConcurrentExecCommands: vi.fn().mockReturnValue(false),
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

function decodePowerShellCommand(command: string): string | null {
  const match = command.match(/-EncodedCommand\s+([A-Za-z0-9+/=]+)/)
  return match ? Buffer.from(match[1], 'base64').toString('utf16le') : null
}

// Exec call order under our mocks (deploy happy path):
//   1: uname              2: $HOME            3: mkdir remoteDir (uploadRelay)
//   4: chmod +x node      5: npm install      6: chmod prebuilds
//   7: probe (cd && node -e require)
//   [8: cat stderr — only when probe stdout is MISSING (graceful path)]
//   8 or 9: rm probe-stderr (best-effort cleanup; runs whenever probe resolved)
//   [next: npm rebuild → chmod → second probe when the first probe is MISSING]
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
  // Result after the automatic rebuild. Defaults to missing so legacy tests
  // continue to exercise the final degraded-mode warning.
  repairProbe?: 'ok' | 'missing'
  // Raw stdout for the build-toolchain probe that runs in installNativeDeps'
  // catch when `npm install` rejects on Linux. Defaults to a fully-present
  // toolchain so the original npm error propagates unchanged.
  toolchainProbe?: string
}): ExecResponse[] {
  // npm install failure aborts the deploy after the catch probes the remote's
  // build toolchain — no chmod/probe/launch slots are reached.
  if (opts.npmInstall !== 'ok') {
    return [
      '__ORCA_REMOTE_PLATFORM__ Linux x86_64',
      '/home/u',
      '', // mkdir remoteDir (uploadRelay)
      '', // chmod +x node
      opts.npmInstall, // npm install rejects
      opts.toolchainProbe ?? 'HAVE make\nHAVE g++\nHAVE cc\nHAVE python3\nPKG apt-get'
    ]
  }
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
    '__ORCA_REMOTE_PLATFORM__ Linux x86_64',
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
    if (!probeOk) {
      slots.push('') // npm rebuild with lifecycle scripts explicitly enabled
      slots.push('') // chmod prebuilds after rebuild
      const repairProbe = opts.repairProbe === 'ok' ? 'ORCA-NPTY-PROBE-OK\n' : 'MISSING\n'
      slots.push(repairProbe)
      if (!repairProbe.includes('ORCA-NPTY-PROBE-OK')) {
        slots.push('') // cat stderr after unsuccessful rebuild
      }
      slots.push('') // rm -f stderr after rebuild probe
    }
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
    vi.mocked(uploadDirectory).mockResolvedValue(undefined)
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
    expect(parsed.allowScripts).toEqual({
      '@parcel/watcher@2.5.6': true,
      'node-pty@1.1.0': true
    })

    const execCalls = vi.mocked(execCommand).mock.calls.map(([, c]) => c)
    const npmInstallIdx = execCalls.findIndex(
      (c) => c.includes('npm install') && c.includes('node-pty') && c.includes('@parcel/watcher')
    )
    expect(npmInstallIdx).toBeGreaterThanOrEqual(0)
    expect(execCalls[npmInstallIdx]).toContain('--ignore-scripts=false')
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

  it('rewrites the npm failure into an actionable build-tools message when the remote toolchain is missing', async () => {
    const conn = makeMockConnection(sftpCapture)
    feed(
      makeExecResponses({
        npmInstall: { reject: 'gyp ERR! stack Error: not found: make' },
        probe: 'ok',
        // No HAVE lines → make/g++ absent; apk present → tailored hint must
        // come from the remote probe rather than a hardcoded apt fallback.
        toolchainProbe: 'PKG apk'
      })
    )

    const error = await deployAndLaunchRelay(conn).catch((e: Error) => e)
    expect(error).toBeInstanceOf(Error)
    const message = (error as Error).message
    // Actionable: names the missing tools and the exact install command.
    expect(message).toContain('build tools')
    expect(message).toContain('make')
    expect(message).toContain('sudo apk add build-base python3')
    // The raw npm/node-gyp output is preserved for triage, not discarded.
    expect(message).toContain('not found: make')

    const execCalls = vi.mocked(execCommand).mock.calls.map(([, c]) => c)
    expect(
      execCalls.some((c) => c.includes('command -v "$t"') && c.includes('command -v "$p"'))
    ).toBe(true)
    expect(vi.mocked(finalizeInstall)).not.toHaveBeenCalled()
  })

  it('preserves the original npm error when it is not a native build-tool failure', async () => {
    const conn = makeMockConnection(sftpCapture)
    feed(
      makeExecResponses({
        npmInstall: { reject: 'npm ERR! network ETIMEDOUT' },
        probe: 'ok',
        // Even if the host also lacks build tools, a network error should stay
        // a network error instead of being relabeled as an install-tools fix.
        toolchainProbe: 'PKG apt-get'
      })
    )

    // The npm output is something else (network, registry), so surface the
    // real error rather than a misleading "install build tools".
    const error = await deployAndLaunchRelay(conn).catch((e: Error) => e)
    expect((error as Error).message).toContain('npm ERR! network ETIMEDOUT')
    expect((error as Error).message).not.toContain('build tools')

    const execCalls = vi.mocked(execCommand).mock.calls.map(([, c]) => c)
    expect(execCalls.some((c) => c.includes('command -v "$t"'))).toBe(false)
  })

  it('preserves redirected npm stdout for non-toolchain failures without probing', async () => {
    const conn = makeMockConnection(sftpCapture)
    feed(
      makeExecResponses({
        npmInstall: {
          reject:
            'Command "export PATH=/usr/bin:$PATH && cd /home/u/.orca-remote/relay && npm install node-pty@1.1.0 2>&1" failed (exit 1): npm ERR! network ETIMEDOUT'
        },
        probe: 'ok',
        toolchainProbe: 'PKG apt-get'
      })
    )

    const error = await deployAndLaunchRelay(conn).catch((e: Error) => e)
    expect((error as Error).message).toContain('npm ERR! network ETIMEDOUT')
    expect((error as Error).message).not.toContain('build tools')

    const execCalls = vi.mocked(execCommand).mock.calls.map(([, c]) => c)
    expect(execCalls.some((c) => c.includes('command -v "$t"'))).toBe(false)
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
    expect(vi.mocked(abandonInstall)).toHaveBeenCalledTimes(1)
  })

  it('rebuilds unloadable native deps and recovers before first relay launch', async () => {
    const conn = makeMockConnection(sftpCapture)
    feed(makeExecResponses({ npmInstall: 'ok', probe: 'missing', repairProbe: 'ok' }))

    await deployAndLaunchRelay(conn)

    const execCalls = vi.mocked(execCommand).mock.calls.map(([, c]) => c)
    const failedProbeIdx = execCalls.findIndex((c) => c.includes('require("node-pty")'))
    const rebuildIdx = execCalls.findIndex((c) => c.includes('npm rebuild'))
    const repairedProbeIdx = execCalls.findIndex(
      (c, index) => index > rebuildIdx && c.includes('require("node-pty")')
    )
    expect(rebuildIdx).toBeGreaterThan(failedProbeIdx)
    expect(execCalls[rebuildIdx]).toContain('--ignore-scripts=false')
    expect(repairedProbeIdx).toBeGreaterThan(rebuildIdx)

    const warnMessages = warnSpy.mock.calls.map((args) => String(args[0] ?? ''))
    expect(warnMessages.some((m) => m.includes('[ssh-relay][NPTY-MISSING]'))).toBe(false)
    expect(vi.mocked(finalizeInstall)).toHaveBeenCalledTimes(1)
  })

  it('propagates an SSH-channel failure from the post-rebuild re-probe', async () => {
    // Why: the rebuild itself degrades gracefully, but the verification probe
    // after it must still surface transport death — conflating a dead channel
    // with "native deps missing" would finalize a half-repaired install.
    const conn = makeMockConnection(sftpCapture)
    feed([
      '__ORCA_REMOTE_PLATFORM__ Linux x86_64', // uname
      '/home/u', // $HOME
      '', // mkdir remoteDir (uploadRelay)
      '', // chmod +x node
      '', // npm install native deps
      '', // chmod prebuilds
      'MISSING\n', // first probe: require() fails
      '', // cat probe stderr
      '', // rm probe stderr
      '', // npm rebuild native deps
      '', // chmod prebuilds after rebuild
      { reject: 'SSH channel closed during native deps re-probe' } // re-probe rejects
    ])

    await expect(deployAndLaunchRelay(conn)).rejects.toThrow(/SSH channel closed/)

    // Rebuild failure is swallowed; a re-probe transport failure must not be.
    const warnMessages = warnSpy.mock.calls.map((args) => String(args[0] ?? ''))
    expect(warnMessages.some((m) => m.includes('[ssh-relay][NPTY-MISSING]'))).toBe(false)
    expect(vi.mocked(finalizeInstall)).not.toHaveBeenCalled()
    expect(vi.mocked(abandonInstall)).toHaveBeenCalledTimes(1)
  })

  it('aborts an in-progress native install and releases its lock at deploy timeout', async () => {
    vi.useFakeTimers()
    try {
      const conn = makeMockConnection(sftpCapture)
      feed([
        '__ORCA_REMOTE_PLATFORM__ Linux x86_64',
        '/home/u',
        '', // mkdir remoteDir
        '' // chmod +x node
      ])
      let installSignal: AbortSignal | undefined
      vi.mocked(execCommand).mockImplementationOnce((_conn, command, options) => {
        expect(command).toContain('npm install')
        installSignal = options?.signal
        return new Promise<string>((_resolve, reject) => {
          installSignal?.addEventListener('abort', () => reject(installSignal?.reason), {
            once: true
          })
        })
      })

      const promise = deployAndLaunchRelay(conn).catch((err: Error) => err)
      await vi.waitFor(() => expect(installSignal).toBeDefined())

      await vi.advanceTimersByTimeAsync(RELAY_DEPLOY_TIMEOUT_MS)

      const result = await promise
      expect(result).toBeInstanceOf(Error)
      expect((result as Error).message).toBe(
        `Relay deployment timed out after ${RELAY_DEPLOY_TIMEOUT_MS / 1000}s`
      )
      expect(installSignal?.aborted).toBe(true)
      expect(vi.mocked(abandonInstall)).toHaveBeenCalledTimes(1)
      expect(vi.mocked(finalizeInstall)).not.toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
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

    // Hold the install lock through launch, then release it exactly once.
    expect(vi.mocked(finalizeInstall)).toHaveBeenCalledTimes(1)
    expect(vi.mocked(abandonInstall)).toHaveBeenCalledTimes(1)
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
    expect(vi.mocked(abandonInstall)).toHaveBeenCalledTimes(1)
  })

  it('keeps Windows node-pty probe failures non-fatal by checking LASTEXITCODE', async () => {
    vi.mocked(parseUnameToRelayPlatform).mockReturnValueOnce('win32-x64')
    vi.mocked(resolveRemoteNodePath).mockResolvedValueOnce('C:/Program Files/nodejs/node.exe')
    const conn = makeMockConnection(sftpCapture)
    feed([
      '__ORCA_REMOTE_PLATFORM__ Windows AMD64',
      'C:\\Users\\u',
      '', // mkdir remoteDir
      '', // npm install native deps
      'MISSING\n', // native process exit normalized by PowerShell command
      '', // npm rebuild native deps
      'MISSING\n', // rebuilt native process still cannot load
      '', // no persisted active pipe marker
      'WAITING',
      '', // WMI relay launch
      'READY',
      '' // persist active pipe marker
    ])

    await deployAndLaunchRelay(conn)

    const probeCommand =
      vi
        .mocked(execCommand)
        .mock.calls.map(([, c]) => c)
        .find((command) => decodePowerShellCommand(command)?.includes('require(\\"node-pty\\")')) ??
      ''
    const probeScript = decodePowerShellCommand(probeCommand) ?? ''
    expect(probeScript).toContain('$LASTEXITCODE -ne 0')
    expect(probeScript).toContain("'MISSING'")
    expect(probeScript).toContain('loadNativeModule')

    const npmScripts = vi
      .mocked(execCommand)
      .mock.calls.map(([, command]) => decodePowerShellCommand(command) ?? '')
      .filter((script) => script.includes('npm install') || script.includes('npm rebuild'))
    expect(npmScripts).toHaveLength(2)
    expect(npmScripts.every((script) => script.includes('--ignore-scripts=false'))).toBe(true)
    expect(
      npmScripts.every((script) =>
        script.includes('if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }')
      )
    ).toBe(true)
    expect(
      vi
        .mocked(execCommand)
        .mock.calls.some(([, command]) => command.includes('.npty-probe.stderr'))
    ).toBe(false)

    const warnMessages = warnSpy.mock.calls.map((args) => String(args[0] ?? ''))
    expect(warnMessages.some((m) => m.includes('[ssh-relay][NPTY-MISSING]'))).toBe(true)
    expect(vi.mocked(finalizeInstall)).toHaveBeenCalledTimes(1)
    expect(vi.mocked(abandonInstall)).toHaveBeenCalledTimes(1)
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
      '__ORCA_REMOTE_PLATFORM__ Linux x86_64',
      '/home/u',
      'ORCA-NATIVE-DEPS-MISSING:@parcel/watcher\nMISSING', // first probe before lock
      'ORCA-NATIVE-DEPS-MISSING:@parcel/watcher\nMISSING', // re-probe after lock
      '', // npm install native deps
      '', // chmod prebuilds
      'ORCA-NPTY-PROBE-OK\n',
      '', // rm probe stderr
      'DEAD',
      'READY'
    ])

    await deployAndLaunchRelay(conn)

    expect(vi.mocked(tryAcquireRelayRepairLock)).toHaveBeenCalledTimes(1)
    expect(vi.mocked(tryAcquireRelayRepairLock).mock.calls[0]?.[3]?.signal).toBeInstanceOf(
      AbortSignal
    )
    expect(vi.mocked(finalizeInstall)).toHaveBeenCalledTimes(1)
    const execCalls = vi.mocked(execCommand).mock.calls.map(([, c]) => c)
    expect(
      execCalls.some(
        (c) => c.includes('npm install') && c.includes('node-pty') && c.includes('@parcel/watcher')
      )
    ).toBe(true)
    const installCommand = execCalls.find((c) => c.includes('npm install')) ?? ''
    expect(installCommand).toContain('node_modules/@parcel/watcher')
    expect(installCommand).toContain("-name 'watcher-*'")
    expect(installCommand).not.toContain("rm -rf 'node_modules/node-pty'")
  })

  it('launches an already-installed relay in degraded mode when repair throws', async () => {
    // Why: a repair failure on a completed dir (e.g. offline/proxy-locked npm)
    // must not block the connection — the relay still serves fs/git/preflight.
    // Pre-fix this rethrew and aborted the whole deploy. The next reconnect
    // retries, so a transient failure self-heals.
    vi.mocked(isRelayAlreadyInstalled).mockResolvedValue(true)
    const conn = makeMockConnection(sftpCapture)
    feed([
      '__ORCA_REMOTE_PLATFORM__ Linux x86_64',
      '/home/u',
      'MISSING', // health probe: require() fails
      'MISSING', // re-probe after lock
      { reject: 'npm ERR! network ETIMEDOUT' }, // npm install fails (offline)
      'DEAD',
      'READY'
    ])

    // Deploy must resolve (degraded), not reject.
    await deployAndLaunchRelay(conn)

    expect(vi.mocked(finalizeInstall)).not.toHaveBeenCalled()
    expect(vi.mocked(abandonInstall)).toHaveBeenCalledTimes(1)
    const warnMessages = warnSpy.mock.calls.map((args) => String(args[0] ?? ''))
    expect(warnMessages.some((m) => m.includes('launching degraded'))).toBe(true)
  })

  it('retains the repair lock when remote command termination is unconfirmed', async () => {
    vi.mocked(isRelayAlreadyInstalled).mockResolvedValue(true)
    const conn = makeMockConnection(sftpCapture)
    vi.mocked(execCommand)
      .mockResolvedValueOnce('__ORCA_REMOTE_PLATFORM__ Linux x86_64')
      .mockResolvedValueOnce('/home/u')
      .mockResolvedValueOnce('MISSING')
      .mockResolvedValueOnce('MISSING')
      .mockRejectedValueOnce(
        Object.assign(new Error('npm termination was not confirmed'), {
          sshChannelCloseConfirmed: false
        })
      )
      .mockResolvedValueOnce('DEAD')
      .mockResolvedValueOnce('READY')

    await deployAndLaunchRelay(conn)

    expect(vi.mocked(abandonInstall)).not.toHaveBeenCalled()
    const warnMessages = warnSpy.mock.calls.map((args) => String(args[0] ?? ''))
    expect(warnMessages.some((message) => message.includes('launching degraded'))).toBe(true)
  })

  it('retains the first-install lock when an aborted npm install has unconfirmed teardown', async () => {
    vi.useFakeTimers()
    try {
      const conn = makeMockConnection(sftpCapture)
      feed([
        '__ORCA_REMOTE_PLATFORM__ Linux x86_64',
        '/home/u',
        '', // mkdir remoteDir
        '' // chmod +x node
      ])
      let installSignal: AbortSignal | undefined
      vi.mocked(execCommand).mockImplementationOnce((_conn, command, options) => {
        expect(command).toContain('npm install')
        installSignal = options?.signal
        return new Promise<string>((_resolve, reject) => {
          installSignal?.addEventListener(
            'abort',
            () => {
              // Mirrors execCommand's bounded close grace when ssh2 never
              // confirms that the remote npm process stopped.
              setTimeout(
                () =>
                  reject(
                    Object.assign(new Error('npm teardown remained unconfirmed'), {
                      sshChannelCloseConfirmed: false
                    })
                  ),
                5_000
              )
            },
            { once: true }
          )
        })
      })

      const deploy = deployAndLaunchRelay(conn).catch((err: Error) => err)
      await vi.waitFor(() => expect(installSignal).toBeDefined())
      await vi.advanceTimersByTimeAsync(RELAY_DEPLOY_TIMEOUT_MS)
      const result = await deploy
      expect(result).toBeInstanceOf(Error)
      expect((result as Error).message).toContain('Relay deployment timed out')
      await vi.advanceTimersByTimeAsync(5_000)

      expect(vi.mocked(abandonInstall)).not.toHaveBeenCalled()
      expect(vi.mocked(finalizeInstall)).not.toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })

  it('does not finalize or release a first-install lock after unconfirmed rebuild teardown', async () => {
    const conn = makeMockConnection(sftpCapture)
    vi.mocked(execCommand)
      .mockResolvedValueOnce('__ORCA_REMOTE_PLATFORM__ Linux x86_64')
      .mockResolvedValueOnce('/home/u')
      .mockResolvedValueOnce('')
      .mockResolvedValueOnce('')
      .mockResolvedValueOnce('')
      .mockResolvedValueOnce('')
      .mockResolvedValueOnce('MISSING')
      .mockResolvedValueOnce('rebuild diagnostics')
      .mockResolvedValueOnce('')
      .mockRejectedValueOnce(
        Object.assign(new Error('rebuild termination was not confirmed'), {
          sshChannelCloseConfirmed: false
        })
      )

    await expect(deployAndLaunchRelay(conn)).rejects.toThrow(
      'rebuild termination was not confirmed'
    )
    expect(vi.mocked(finalizeInstall)).not.toHaveBeenCalled()
    expect(vi.mocked(abandonInstall)).not.toHaveBeenCalled()
  })

  it('retains the first-install lock when an aborted rebuild has unconfirmed teardown', async () => {
    vi.useFakeTimers()
    try {
      const conn = makeMockConnection(sftpCapture)
      feed([
        '__ORCA_REMOTE_PLATFORM__ Linux x86_64',
        '/home/u',
        '', // mkdir remoteDir
        '', // chmod +x node
        '', // npm install
        '', // chmod prebuilds
        'MISSING',
        'rebuild diagnostics',
        '' // remove probe diagnostics
      ])
      let rebuildSignal: AbortSignal | undefined
      vi.mocked(execCommand).mockImplementationOnce((_conn, command, options) => {
        expect(command).toContain('npm rebuild')
        rebuildSignal = options?.signal
        return new Promise<string>((_resolve, reject) => {
          rebuildSignal?.addEventListener(
            'abort',
            () => {
              setTimeout(
                () =>
                  reject(
                    Object.assign(new Error('rebuild teardown remained unconfirmed'), {
                      sshChannelCloseConfirmed: false
                    })
                  ),
                5_000
              )
            },
            { once: true }
          )
        })
      })

      const deploy = deployAndLaunchRelay(conn).catch((err: Error) => err)
      await vi.waitFor(() => expect(rebuildSignal).toBeDefined())
      await vi.advanceTimersByTimeAsync(RELAY_DEPLOY_TIMEOUT_MS)
      const result = await deploy
      expect(result).toBeInstanceOf(Error)
      expect((result as Error).message).toContain('Relay deployment timed out')
      await vi.advanceTimersByTimeAsync(5_000)

      expect(vi.mocked(abandonInstall)).not.toHaveBeenCalled()
      expect(vi.mocked(finalizeInstall)).not.toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })

  it.each(['busy', 'error'] as const)('launches degraded when lock is %s', async (lockResult) => {
    // Why: lock contention/wedge must not block a completed relay from launching
    // in degraded mode — repair is best-effort and we hold no lock to release.
    vi.mocked(isRelayAlreadyInstalled).mockResolvedValue(true)
    vi.mocked(tryAcquireRelayRepairLock).mockResolvedValueOnce(lockResult)
    const conn = makeMockConnection(sftpCapture)
    feed(['__ORCA_REMOTE_PLATFORM__ Linux x86_64', '/home/u', 'MISSING', 'DEAD', 'READY'])

    await deployAndLaunchRelay(conn)

    expect(vi.mocked(finalizeInstall)).not.toHaveBeenCalled()
    expect(vi.mocked(abandonInstall)).not.toHaveBeenCalled()
    const execCalls = vi.mocked(execCommand).mock.calls.map(([, c]) => c)
    expect(execCalls.some((c) => c.includes('npm install'))).toBe(false)
    const warnMessages = warnSpy.mock.calls.map((args) => String(args[0] ?? ''))
    expect(warnMessages.some((m) => m.includes(`repair lock is ${lockResult}`))).toBe(true)
  })

  it('loads native bindings when checking whether a completed relay needs repair', async () => {
    vi.mocked(isRelayAlreadyInstalled).mockResolvedValue(true)
    const conn = makeMockConnection(sftpCapture)
    feed([
      '__ORCA_REMOTE_PLATFORM__ Linux x86_64',
      '/home/u',
      'ORCA-NATIVE-DEPS-OK',
      'DEAD',
      'READY'
    ])

    await deployAndLaunchRelay(conn)

    const healthProbe = vi
      .mocked(execCommand)
      .mock.calls.map(([, c]) => c)
      .find((c) => c.includes('ORCA-NATIVE-DEPS-OK'))
    expect(healthProbe).toContain('require("node-pty")')
    expect(healthProbe).toContain('loadNativeModule')
    expect(healthProbe).toContain('require("@parcel/watcher")')
    expect(healthProbe).not.toContain('require.resolve')
  })

  it('does not mutate an existing relay dir when required native deps are present', async () => {
    vi.mocked(isRelayAlreadyInstalled).mockResolvedValue(true)
    const conn = makeMockConnection(sftpCapture)
    feed([
      '__ORCA_REMOTE_PLATFORM__ Linux x86_64',
      '/home/u',
      'ORCA-NATIVE-DEPS-OK',
      'DEAD',
      'READY'
    ])

    await deployAndLaunchRelay(conn)

    expect(vi.mocked(acquireInstallLock)).not.toHaveBeenCalled()
    expect(vi.mocked(tryAcquireRelayRepairLock)).toHaveBeenCalledTimes(1)
    expect(vi.mocked(finalizeInstall)).not.toHaveBeenCalled()
    expect(vi.mocked(abandonInstall)).toHaveBeenCalledTimes(1)
    const execCalls = vi.mocked(execCommand).mock.calls.map(([, c]) => c)
    expect(execCalls.some((c) => c.includes('npm install'))).toBe(false)
  })
})
