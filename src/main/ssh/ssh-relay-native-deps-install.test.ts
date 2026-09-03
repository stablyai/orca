// Why: regression coverage for the install-probe contract — the "node-pty is not available" bug shipped because every guard layer was silent.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type * as RelayInstallMarkerModule from './ssh-relay-install-marker'

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

vi.mock('./ssh-relay-install-marker', async (importOriginal) => ({
  ...(await importOriginal<typeof RelayInstallMarkerModule>()),
  createRelayInstallMarkerFileName: () => '.sftp-namespace-00000000000000000000000000000000'
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
  acquireInstallLock: vi.fn().mockResolvedValue(undefined),
  RELAY_INSTALL_LOCK_NAME: '.install-lock'
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
import {
  BOTH_NATIVE_DEPS_MISSING_PROBE,
  decodePowerShellCommand,
  makeExecResponses,
  makeMockConnection,
  makeRepairToolchainSkipExecResponses,
  makeStagedFirstInstallExecPrefix,
  type ExecResponse,
  type SftpWriteCapture
} from './ssh-relay-native-deps-install-fixture'

describe('installNativeDeps (via deployAndLaunchRelay)', () => {
  let warnSpy: ReturnType<typeof vi.spyOn>
  const sftpCapture: SftpWriteCapture = {
    paths: [],
    contents: {},
    execCallCountAtWrite: {}
  }

  beforeEach(() => {
    vi.clearAllMocks()
    // mockReset because clearAllMocks keeps queued mockResolvedValueOnce entries, so a leaked response would bleed into the next test.
    vi.mocked(execCommand).mockReset().mockResolvedValue('')
    vi.mocked(uploadDirectory).mockResolvedValue(undefined)
    sftpCapture.paths.length = 0
    for (const k of Object.keys(sftpCapture.contents)) {
      delete sftpCapture.contents[k]
    }
    for (const k of Object.keys(sftpCapture.execCallCountAtWrite)) {
      delete sftpCapture.execCallCountAtWrite[k]
    }
    // Re-prime as defense-in-depth: factory mocks survive clearAllMocks but a test's own resetAllMocks would drop them.
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

  it('propagates a hard `npm install` failure so the deploy aborts before finalizeInstall', async () => {
    const conn = makeMockConnection(sftpCapture)
    feed(
      makeExecResponses({
        npmInstall: { reject: 'npm ERR! E404 Not Found node-pty' },
        probe: 'ok'
      })
    )

    await expect(deployAndLaunchRelay(conn)).rejects.toThrow(/npm ERR/)

    // Regression: previously the catch swallowed the throw and finalizeInstall ran anyway.
    expect(vi.mocked(finalizeInstall)).not.toHaveBeenCalled()

    const warnMessages = warnSpy.mock.calls.map((args) => String(args[0] ?? ''))
    expect(warnMessages.some((m) => m.includes('[ssh-relay][NATIVE-DEPS-INSTALL-FAIL]'))).toBe(true)
  })

  it('connects without node-pty when the remote toolchain is missing, instead of failing the host', async () => {
    const conn = makeMockConnection(sftpCapture)
    feed(
      makeExecResponses({
        npmInstall: { reject: 'gyp ERR! stack Error: not found: make' },
        nodePtySkipRetry: 'ok',
        toolchainProbe: 'PKG apk'
      })
    )

    // node-pty only backs terminals, so a host that cannot compile it still gets files and git.
    await expect(deployAndLaunchRelay(conn)).resolves.toBeDefined()
    expect(vi.mocked(finalizeInstall)).toHaveBeenCalled()

    const execCalls = vi.mocked(execCommand).mock.calls.map(([, c]) => c)
    const reinstall = execCalls.findLast((c) => c.includes('npm install')) ?? ''
    expect(reinstall).toContain('@parcel/watcher@')
    expect(reinstall).not.toContain('node-pty@')
    // The skip path must stop here: rebuilding is pointless on a host with no compiler.
    expect(execCalls.some((c) => c.includes('npm rebuild'))).toBe(false)
    // node-pty is legitimately absent, so its probe result must not raise the degraded-mode alarm.
    const warnMessages = warnSpy.mock.calls.map((args) => String(args[0] ?? ''))
    expect(warnMessages.some((m) => m.includes('[ssh-relay][WATCHER-MISSING-NPTY-SKIPPED]'))).toBe(
      false
    )
    // The rewritten manifest must drop node-pty too, or npm reconciles it back and rebuilds.
    const pkgPath = sftpCapture.paths.findLast((p) => p.endsWith('/package.json')) as string
    // The capture concatenates every write to a path; the rewrite is the last manifest line.
    const latest = sftpCapture.contents[pkgPath].trim().split('\n').at(-1) as string
    const deps = (JSON.parse(latest) as { dependencies: object }).dependencies
    expect(deps).toHaveProperty('@parcel/watcher')
    expect(deps).not.toHaveProperty('node-pty')
  })

  it('warns when @parcel/watcher is also unloadable after node-pty was skipped', async () => {
    const conn = makeMockConnection(sftpCapture)
    feed(
      makeExecResponses({
        npmInstall: { reject: 'gyp ERR! stack Error: not found: make' },
        nodePtySkipRetry: 'ok',
        nodePtySkipWatcher: 'missing'
      })
    )

    // Watcher failure (e.g. glibc below the floor) is non-fatal, but silent dead file watching is not acceptable.
    await expect(deployAndLaunchRelay(conn)).resolves.toBeDefined()
    const warnMessages = warnSpy.mock.calls.map((args) => String(args[0] ?? ''))
    expect(warnMessages.some((m) => m.includes('[ssh-relay][WATCHER-MISSING-NPTY-SKIPPED]'))).toBe(
      true
    )
    expect(vi.mocked(finalizeInstall)).toHaveBeenCalledTimes(1)
    const execCalls = vi.mocked(execCommand).mock.calls.map(([, c]) => c)
    expect(execCalls.some((c) => c.includes('npm rebuild'))).toBe(false)
  })

  it('hard-fails on a gyp error when the remote toolchain is actually complete', async () => {
    const conn = makeMockConnection(sftpCapture)
    feed(
      makeExecResponses({
        npmInstall: { reject: 'gyp ERR! stack Error: not found: make' },
        // Probe contradicts the gyp output: the tools are all there, so the real cause is unknown.
        toolchainProbe: 'HAVE make\nHAVE g++\nHAVE python3\nPKG apt-get'
      })
    )

    const error = await deployAndLaunchRelay(conn).catch((e: Error) => e)
    // Degrading here would silently drop terminals on a host that can build them.
    expect((error as Error).message).toContain('gyp ERR!')
    expect((error as Error).message).not.toContain('build tools')

    const execCalls = vi.mocked(execCommand).mock.calls.map(([, c]) => c)
    expect(execCalls.filter((c) => c.includes('npm install'))).toHaveLength(1)
    expect(execCalls.some((c) => c.includes("rm -rf 'node_modules/node-pty'"))).toBe(false)
    expect(vi.mocked(finalizeInstall)).not.toHaveBeenCalled()
  })

  it('still reports the actionable build-tools error when the node-pty-less retry also fails', async () => {
    const conn = makeMockConnection(sftpCapture)
    feed(
      makeExecResponses({
        npmInstall: { reject: 'gyp ERR! stack Error: not found: make' },
        // No HAVE lines + apk present: the tailored hint must come from the remote probe, not a hardcoded apt fallback.
        toolchainProbe: 'PKG apk',
        nodePtySkipRetry: { reject: 'npm ERR! registry unreachable' }
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
    // The retry's own cause is unrelated to the toolchain, so it must survive as cause + a log line.
    expect((error as Error).cause).toBeInstanceOf(Error)
    expect(((error as Error).cause as Error).message).toContain('registry unreachable')
    const warnMessages = warnSpy.mock.calls.map((args) => String(args[0] ?? ''))
    expect(
      warnMessages.some(
        (m) => m.includes('[ssh-relay][NPTY-SKIP-RETRY-FAIL]') && m.includes('registry unreachable')
      )
    ).toBe(true)
    expect(vi.mocked(finalizeInstall)).not.toHaveBeenCalled()
  })

  it('preserves the original npm error when it is not a native build-tool failure', async () => {
    const conn = makeMockConnection(sftpCapture)
    feed(
      makeExecResponses({
        npmInstall: { reject: 'npm ERR! network ETIMEDOUT' },
        probe: 'ok',
        // A network error must stay a network error even if the host also lacks build tools.
        toolchainProbe: 'PKG apt-get'
      })
    )

    // Non-toolchain npm error (network/registry): surface the real error, not a misleading "install build tools".
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

    // Probe failure is non-fatal by design (docs/ssh-relay-versioned-install-dirs.md): throwing would loop reconnects forever where node-pty can't build.
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
    // Why: rebuild degrades gracefully, but the post-rebuild probe must surface transport death, else a dead channel finalizes a half-repaired install.
    const conn = makeMockConnection(sftpCapture)
    feed([
      ...makeStagedFirstInstallExecPrefix(),
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
      feed(makeStagedFirstInstallExecPrefix())
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

  it('does not rewrite node_modules when the health probe never answered', async () => {
    // Why (#14830): a wedged `require("node-pty")` makes the probe time out. Reading that silence
    // as "every native dep is missing" sent a healthy install through npm install + rebuild that
    // could not help, and the retry loop burned the whole deploy budget at "Deploying relay…".
    const conn = makeMockConnection(sftpCapture)
    vi.mocked(isRelayAlreadyInstalled).mockResolvedValue(true)
    feed([
      '__ORCA_REMOTE_PLATFORM__ Linux x86_64',
      '/home/u',
      { reject: 'Command "node -e ..." timed out after 30s' } // health probe never answered
    ])

    await deployAndLaunchRelay(conn).catch(() => {})

    const execCalls = vi.mocked(execCommand).mock.calls.map(([, c]) => c)
    expect(execCalls.some((c) => c.includes('npm install'))).toBe(false)
    expect(execCalls.some((c) => c.includes('npm rebuild'))).toBe(false)

    const warnMessages = warnSpy.mock.calls.map((args) => String(args[0] ?? ''))
    expect(warnMessages.some((m) => m.includes('Repairing missing native deps'))).toBe(false)
    // Why no log assertion: the behavioural claim above is the real one. Asserting on warn text
    // pinned wording that main's landed probe verdict does not use, and #18000 adds its own.
    expect(execCalls.some((c) => c.includes("rm -rf 'node_modules/node-pty'"))).toBe(false)
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

    // Pin the rejection to the PROBE call so slot-ordering drift can't pass this test via a different failure path.
    const execCalls = vi.mocked(execCommand).mock.calls.map(([, c]) => c)
    const probeCallIdx = execCalls.findIndex((c) => c.includes('require("node-pty")'))
    const npmInstallIdx = execCalls.findIndex(
      (c) => c.includes('npm install') && c.includes('node-pty') && c.includes('@parcel/watcher')
    )
    expect(probeCallIdx, 'probe must have been invoked').toBeGreaterThanOrEqual(0)
    // Probe must come strictly after npm install, else it probes an empty dir and doesn't represent the real-world race.
    expect(probeCallIdx).toBeGreaterThan(npmInstallIdx)

    const warnMessages = warnSpy.mock.calls.map((args) => String(args[0] ?? ''))
    // Channel failure must not be conflated with "node-pty missing" or "npm install failed".
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

    // Why: cd-failure short-circuits the probe's && so it rejects instead of resolving MISSING; conflating "dir gone" with "node-pty missing" strands the user in degraded mode.
    await expect(deployAndLaunchRelay(conn)).rejects.toThrow(/cd:/)

    // Pin the rejection to the probe slot so a refactor moving probe before npm install can't pass this test for the wrong reason.
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

    // Why: probe must require('node-pty') via the node binary; a weaker test -d passes even when the native binding load is broken.
    expect(probeCmds.length).toBeGreaterThan(0)
    expect(probeCmds[0]).toMatch(/node['"]?\s+-e/)

    // Pin order npm install → chmod prebuilds → probe: chmod-after-probe breaks spawn-helper bits; probe-before-install tests an empty dir.
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
    // Why: noisy .bashrc/MOTD can prefix probe stdout; production uses .includes(PROBE_OK) so pre-sentinel noise still resolves OK.
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

    // Absence of PROBE_OK triggers the warn regardless of surrounding noise; finalize still runs by design.
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
      '', // bounded stale-stage recovery
      '__ORCA_UPLOAD_STAGE_SLOT__.sftp-namespace-00000000000000000000000000000000:slot-0',
      '__ORCA_UPLOAD_STAGE_PROMOTION__.sftp-namespace-00000000000000000000000000000000:PROMOTED',
      '', // npm install native deps
      'MISSING\n', // native process exit normalized by PowerShell command
      '', // npm rebuild native deps
      'MISSING\n', // rebuilt native process still cannot load
      '', // clean stage root
      '', // no persisted active pipe marker
      'WAITING', // initial pipe probe
      '', // publish the per-launch credential
      '', // WMI relay launch
      'READY', // readiness poll
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
    // Platform tuple lets bug reports be triaged for prebuild availability without asking the user for their arch.
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
    vi.mocked(execCommand).mockReset().mockResolvedValue('')

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
      '', // SFTP-namespace install-owner marker (repair)
      '', // npm install native deps
      '', // chmod prebuilds
      'ORCA-NPTY-PROBE-OK\n',
      '', // rm probe stderr
      'ORCA-NPTY-CLOEXEC:patched\n', // pty-master cloexec patch on the loadable node-pty
      'DEAD',
      '', // publish the per-launch credential
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

  it('keeps the caller resets when a repair reconnect has to drop node-pty', async () => {
    vi.mocked(isRelayAlreadyInstalled).mockResolvedValue(true)
    const conn = makeMockConnection(sftpCapture)
    feed(makeRepairToolchainSkipExecResponses())

    await expect(deployAndLaunchRelay(conn)).resolves.toBeDefined()
    expect(vi.mocked(finalizeInstall)).toHaveBeenCalledTimes(1)

    const execCalls = vi.mocked(execCommand).mock.calls.map(([, c]) => c)
    const reinstall = execCalls.findLast((c) => c.includes('npm install')) ?? ''
    expect(reinstall).not.toContain('node-pty@')
    expect(reinstall).toContain("rm -rf 'node_modules/node-pty'")
    // Dropping the repair's own resets here leaves npm calling the broken watcher up to date.
    expect(reinstall).toContain("rm -rf 'node_modules/@parcel/watcher'")
    expect(reinstall).toContain("-name 'watcher-*'")
  })

  it('launches an already-installed relay in degraded mode when repair throws', async () => {
    // Why: a repair failure on a completed dir must not block the connection — relay still serves fs/git/preflight; next reconnect retries.
    vi.mocked(isRelayAlreadyInstalled).mockResolvedValue(true)
    const conn = makeMockConnection(sftpCapture)
    feed([
      '__ORCA_REMOTE_PLATFORM__ Linux x86_64',
      '/home/u',
      BOTH_NATIVE_DEPS_MISSING_PROBE, // health probe: require() names both deps
      BOTH_NATIVE_DEPS_MISSING_PROBE, // re-probe after lock
      '', // SFTP-namespace install-owner marker (repair)
      { reject: 'npm ERR! network ETIMEDOUT' }, // npm install fails (offline)
      'DEAD',
      '', // remote credential generation after degraded repair
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
      .mockResolvedValueOnce(BOTH_NATIVE_DEPS_MISSING_PROBE)
      .mockResolvedValueOnce(BOTH_NATIVE_DEPS_MISSING_PROBE)
      .mockResolvedValueOnce('') // SFTP-namespace install-owner marker (repair)
      .mockRejectedValueOnce(
        Object.assign(new Error('npm termination was not confirmed'), {
          sshChannelCloseConfirmed: false
        })
      )
      .mockResolvedValueOnce('DEAD')
      .mockResolvedValueOnce('') // remote credential generation after degraded repair
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
      feed(makeStagedFirstInstallExecPrefix())
      let installSignal: AbortSignal | undefined
      vi.mocked(execCommand).mockImplementationOnce((_conn, command, options) => {
        expect(command).toContain('npm install')
        installSignal = options?.signal
        return new Promise<string>((_resolve, reject) => {
          installSignal?.addEventListener(
            'abort',
            () => {
              // Mirrors execCommand's bounded close grace when ssh2 never confirms npm stopped.
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
      await vi.advanceTimersByTimeAsync(5_000)
      const result = await deploy
      expect(result).toBeInstanceOf(Error)
      expect((result as Error).message).toContain('Relay deployment timed out')
      expect(vi.mocked(abandonInstall)).not.toHaveBeenCalled()
      expect(vi.mocked(finalizeInstall)).not.toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })

  it('does not finalize or release a first-install lock after unconfirmed rebuild teardown', async () => {
    const conn = makeMockConnection(sftpCapture)
    feed([
      ...makeStagedFirstInstallExecPrefix(),
      '', // npm install
      '', // chmod prebuilds
      'MISSING',
      'rebuild diagnostics',
      '' // remove probe diagnostics
    ])
    vi.mocked(execCommand).mockRejectedValueOnce(
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
        ...makeStagedFirstInstallExecPrefix(),
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
      await vi.advanceTimersByTimeAsync(5_000)
      const result = await deploy
      expect(result).toBeInstanceOf(Error)
      expect((result as Error).message).toContain('Relay deployment timed out')
      expect(vi.mocked(abandonInstall)).not.toHaveBeenCalled()
      expect(vi.mocked(finalizeInstall)).not.toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })

  it.each(['busy', 'error'] as const)('launches degraded when lock is %s', async (lockResult) => {
    // Why: lock contention/wedge must not block a completed relay from launching in degraded mode.
    vi.mocked(isRelayAlreadyInstalled).mockResolvedValue(true)
    vi.mocked(tryAcquireRelayRepairLock).mockResolvedValueOnce(lockResult)
    const conn = makeMockConnection(sftpCapture)
    feed([
      '__ORCA_REMOTE_PLATFORM__ Linux x86_64',
      '/home/u',
      BOTH_NATIVE_DEPS_MISSING_PROBE,
      'DEAD',
      '', // remote credential generation without a namespace marker
      'READY'
    ])

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
      '', // launch namespace marker
      'DEAD',
      '', // publish the per-launch credential
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
      '', // launch namespace marker
      'DEAD',
      '', // publish the per-launch credential
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
