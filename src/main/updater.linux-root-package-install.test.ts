import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type * as UpdaterModule from './updater'
import type * as RecoveryModule from './linux-package-update-recovery'
import type { UpdateStatus } from '../shared/update-status-types'
import { PRE_COMMIT_INSTALL_FAILURE } from './updater-test-harness'

const {
  browserWindowMock,
  nativeUpdaterMock,
  autoUpdaterMock,
  killAllPtyMock,
  getLinuxRootPackageTypeMock,
  recordUpdaterLifecycleMock,
  armExitWatchdogMock,
  disarmExitWatchdogMock,
  fetchNewerReleaseTagsMock,
  moduleFactories,
  resetUpdaterMocks
} = await vi.hoisted(async () => (await import('./updater-test-harness')).createUpdaterMocks())

vi.mock('electron', () => moduleFactories.electron())
vi.mock('electron-updater', () => moduleFactories.electronUpdater())
vi.mock('./electron-updater-loader', () => moduleFactories.electronUpdaterLoader())
vi.mock('@electron-toolkit/utils', () => moduleFactories.electronToolkitUtils())
vi.mock('./ipc/pty', () => moduleFactories.ipcPty())
vi.mock('./linux-update-package-type', () => moduleFactories.linuxUpdatePackageType())
vi.mock('./updater-lifecycle-diagnostics', () => moduleFactories.updaterLifecycleDiagnostics())
vi.mock('./updater-changelog', () => moduleFactories.updaterChangelog())
vi.mock('./updater-nudge', () => moduleFactories.updaterNudge())
vi.mock('./update-install-exit-watchdog', () => moduleFactories.updateInstallExitWatchdog())
vi.mock('./updater-prerelease-feed', () => moduleFactories.updaterPrereleaseFeed())
vi.mock('./local-builds/local-build-switch', () => moduleFactories.localBuildSwitch())
vi.mock('./local-builds/local-build-feed-server', () => moduleFactories.localBuildFeedServer())

type RevalidationVerdict = Awaited<
  ReturnType<typeof RecoveryModule.revalidateLinuxPackageForInstall>
>

// Captured before any vi.useFakeTimers() call: the only handle left that still yields to libuv.
const realSetTimeout = globalThis.setTimeout

type StagedLinuxPackages = {
  cacheRoot: string
  debPath: string
  debSha512: string
  rpmPath: string
  rpmSha512: string
}

/**
 * Stages real packages inside a real updater cache: every install re-proves the retained digest by
 * streaming the file off disk, so a path that never existed would abort before reaching the native
 * updater. Returns the actual digests for the download events.
 */
function stageLinuxUpdateCache(): StagedLinuxPackages {
  const cacheRoot = mkdtempSync(join(tmpdir(), 'orca-updater-cache-'))
  const pendingDir = join(cacheRoot, 'orca-updater', 'pending')
  mkdirSync(pendingDir, { recursive: true })
  const stagePackage = (fileName: string): { path: string; sha512: string } => {
    const packagePath = join(pendingDir, fileName)
    const bytes = Buffer.from(`orca test package ${fileName}`)
    writeFileSync(packagePath, bytes)
    return { path: packagePath, sha512: createHash('sha512').update(bytes).digest('base64') }
  }
  const deb = stagePackage('orca-ide_1.0.61_amd64.deb')
  const rpm = stagePackage('orca-ide-1.0.61.x86_64.rpm')
  return {
    cacheRoot,
    debPath: deb.path,
    debSha512: deb.sha512,
    rpmPath: rpm.path,
    rpmSha512: rpm.sha512
  }
}

type RevalidationProbe = {
  /** Switch to held mode, where a verdict only lands when the test says so. Must precede startUpdater. */
  hold: () => void
  settle: (verdict: RevalidationVerdict) => void
  fail: (error: Error) => void
  invocationCount: () => number
  /** Resolves once every re-proof this test started has finished. */
  drain: () => Promise<void>
}

/** One outstanding re-proof; `awaitable` stays false while a held verdict has no way to settle. */
type OutstandingRevalidation = { promise: Promise<unknown>; awaitable: boolean }

/**
 * Wraps the pre-install re-proof so tests can await the real disk read instead of budgeting
 * event-loop turns, and can hold a verdict open at an exact point in the cycle. Only that one call
 * is wrapped — the artifact state stays real.
 */
function probeRevalidation(): RevalidationProbe {
  type Artifact = Parameters<typeof RecoveryModule.revalidateLinuxPackageForInstall>[0]
  let held = false
  let invocationCount = 0
  let pending: {
    resolve: (verdict: RevalidationVerdict) => void
    reject: (error: Error) => void
    entry: OutstandingRevalidation
  } | null = null
  const outstanding: OutstandingRevalidation[] = []

  const track = (verdict: Promise<RevalidationVerdict>, awaitable: boolean) => {
    const noop = (): void => undefined
    const entry: OutstandingRevalidation = { promise: verdict.then(noop, noop), awaitable }
    outstanding.push(entry)
    return entry
  }

  vi.doMock('./linux-package-update-recovery', async () => {
    const actual = await vi.importActual<typeof RecoveryModule>('./linux-package-update-recovery')
    return {
      ...actual,
      revalidateLinuxPackageForInstall: vi.fn((artifact: Artifact) => {
        invocationCount += 1
        if (!held) {
          const verdict = actual.revalidateLinuxPackageForInstall(artifact)
          track(verdict, true)
          return verdict
        }
        let resolve!: (verdict: RevalidationVerdict) => void
        let reject!: (error: Error) => void
        const verdict = new Promise<RevalidationVerdict>((res, rej) => {
          resolve = res
          reject = rej
        })
        pending = { resolve, reject, entry: track(verdict, false) }
        return verdict
      })
    }
  })

  const release = (): typeof pending => {
    const current = pending
    if (current) {
      current.entry.awaitable = true
      pending = null
    }
    return current
  }

  return {
    hold: () => {
      held = true
    },
    settle: (verdict) => release()?.resolve(verdict),
    fail: (error) => release()?.reject(error),
    invocationCount: () => invocationCount,
    drain: async () => {
      // A verdict still held open can never settle on its own, so draining skips it.
      let ready = outstanding.filter((entry) => entry.awaitable)
      while (ready.length > 0) {
        for (const entry of ready) {
          outstanding.splice(outstanding.indexOf(entry), 1)
        }
        await Promise.all(ready.map((entry) => entry.promise))
        ready = outstanding.filter((entry) => entry.awaitable)
      }
    }
  }
}

describe('updater', () => {
  beforeEach(() => {
    resetUpdaterMocks()
  })

  describe('linux root package install recovery', () => {
    let staged: StagedLinuxPackages
    let EXIT_127: string
    let revalidation: RevalidationProbe

    // Why: the quit timer needs fake time, and the work it starts needs real event-loop turns —
    // fake timers never advance libuv. The re-proof itself is awaited rather than counted out
    // (#15243): its disk read is wall-clock bound, so a loaded runner outlasts any turn budget and
    // the tail lands in the next test.
    const settleQuitAndInstall = async (): Promise<void> => {
      await vi.advanceTimersByTimeAsync(100)
      await revalidation.drain()
      for (let turn = 0; turn < 40; turn += 1) {
        await new Promise((resolve) => realSetTimeout(resolve, 0))
      }
      await vi.advanceTimersByTimeAsync(0)
    }

    beforeEach(() => {
      staged = stageLinuxUpdateCache()
      vi.stubEnv('XDG_CACHE_HOME', staged.cacheRoot)
      EXIT_127 = `Command failed: /usr/bin/pkexec /usr/bin/dpkg -i ${staged.debPath}, exited with code 127`
      revalidation = probeRevalidation()
    })

    afterEach(async () => {
      // Why: an unfinished re-proof keeps running against this test's module instance, whose mocks
      // are the same singletons the next test asserts on — it would double every install-path count.
      await revalidation.drain()
      vi.doUnmock('./linux-package-update-recovery')
      vi.unstubAllEnvs()
      rmSync(staged.cacheRoot, { recursive: true, force: true })
    })

    const lastStatus = (send: ReturnType<typeof vi.fn>): UpdateStatus | undefined =>
      send.mock.calls.findLast(([channel]) => channel === 'updater:status')?.[1]

    const PRE_COMMIT_FAILURE_MESSAGE = PRE_COMMIT_INSTALL_FAILURE
    const AGENT_STDERR =
      'pkexec: Error executing command as another user: No authentication agent found.'

    const downloadedEvent = (overrides?: Record<string, unknown>): Record<string, unknown> => ({
      version: '1.0.61',
      downloadedFile: staged.debPath,
      files: [{ url: 'orca-ide_1.0.61_amd64.deb', sha512: staged.debSha512 }],
      ...overrides
    })

    const rpmDownloadedEvent = (): Record<string, unknown> =>
      downloadedEvent({
        downloadedFile: staged.rpmPath,
        files: [{ url: 'orca-ide-1.0.61.x86_64.rpm', sha512: staged.rpmSha512 }]
      })

    const startUpdater = async (
      packageType: 'deb' | 'rpm' | null
    ): Promise<{ send: ReturnType<typeof vi.fn>; updater: typeof UpdaterModule }> => {
      getLinuxRootPackageTypeMock.mockReturnValue(packageType)
      vi.useFakeTimers()
      fetchNewerReleaseTagsMock.mockResolvedValue({ tags: ['v1.0.61'], state: 'ready' })
      autoUpdaterMock.checkForUpdates.mockImplementation(() => {
        autoUpdaterMock.emit('checking-for-update')
        queueMicrotask(() => autoUpdaterMock.emit('update-available', { version: '1.0.61' }))
        return Promise.resolve(undefined)
      })
      const send = vi.fn()
      const updater = await import('./updater')
      updater.setupAutoUpdater({ webContents: { send } } as never, {
        getLastUpdateCheckAt: () => Date.now()
      })
      return { send, updater }
    }

    const reachDownloaded = async (
      updater: typeof UpdaterModule,
      event: Record<string, unknown>
    ): Promise<void> => {
      updater.checkForUpdatesFromMenu()
      await vi.advanceTimersByTimeAsync(0)
      autoUpdaterMock.emit('update-downloaded', event)
      if (process.platform === 'darwin') {
        const nativeReady = nativeUpdaterMock.on.mock.calls.find(
          ([eventName]) => eventName === 'update-downloaded'
        )?.[1] as (() => void) | undefined
        nativeReady?.()
      }
      await vi.advanceTimersByTimeAsync(0)
    }

    it('disables install-on-quit for deb and rpm root packages', async () => {
      for (const packageType of ['deb', 'rpm'] as const) {
        vi.resetModules()
        autoUpdaterMock.autoInstallOnAppQuit = true
        getLinuxRootPackageTypeMock.mockReturnValue(packageType)
        const { setupAutoUpdater } = await import('./updater')

        setupAutoUpdater({ webContents: { send: vi.fn() } } as never, {
          getLastUpdateCheckAt: () => Date.now(),
          installMode: 'interactive'
        })

        expect(autoUpdaterMock.autoInstallOnAppQuit).toBe(false)
      }
    })

    it('keeps interactive install-on-quit when no root-package marker is present', async () => {
      autoUpdaterMock.autoInstallOnAppQuit = false
      const { setupAutoUpdater } = await import('./updater')

      setupAutoUpdater({ webContents: { send: vi.fn() } } as never, {
        getLastUpdateCheckAt: () => Date.now(),
        installMode: 'interactive'
      })

      expect(autoUpdaterMock.autoInstallOnAppQuit).toBe(true)
    })

    it('leaves headless serve installs supervisor-controlled', async () => {
      for (const installMode of [
        'supervised-headless-serve',
        'unsupported-headless-serve'
      ] as const) {
        vi.resetModules()
        autoUpdaterMock.autoInstallOnAppQuit = true
        const { setupAutoUpdater } = await import('./updater')

        setupAutoUpdater({ webContents: { send: vi.fn() } } as never, {
          getLastUpdateCheckAt: () => Date.now(),
          installMode
        })

        expect(autoUpdaterMock.autoInstallOnAppQuit).toBe(false)
      }
    })

    it('sends structured recovery when quitAndInstall throws synchronously', async () => {
      const { send, updater } = await startUpdater('deb')
      await reachDownloaded(updater, downloadedEvent())
      autoUpdaterMock.quitAndInstall.mockImplementation(() => {
        autoUpdaterMock.logger?.error(`${AGENT_STDERR} target ${staged.debPath}`)
        throw new Error(EXIT_127)
      })

      updater.quitAndInstall()
      await settleQuitAndInstall()

      // Why: the sync throw ends capture before the catch, so the stashed text must survive.
      expect(send).toHaveBeenCalledWith('updater:status', {
        state: 'error',
        message: `${AGENT_STDERR} target <package>`,
        recovery: {
          kind: 'linux-package-install',
          packageType: 'deb',
          reason: 'authentication-agent-unavailable',
          version: '1.0.61'
        }
      })
    })

    it('recovers an event-driven pre-commit failure without tearing down the session', async () => {
      const openWindow = { removeAllListeners: vi.fn() }
      browserWindowMock.getAllWindows.mockReturnValue([openWindow] as never)
      const { send, updater } = await startUpdater('rpm')
      await reachDownloaded(updater, rpmDownloadedEvent())
      autoUpdaterMock.quitAndInstall.mockImplementation(() => {
        autoUpdaterMock.emit('error', new Error('Command failed, exited with code 1'))
      })

      updater.quitAndInstall()
      await settleQuitAndInstall()

      expect(send).toHaveBeenCalledWith('updater:status', {
        state: 'error',
        message: 'Command failed, exited with code 1',
        recovery: {
          kind: 'linux-package-install',
          packageType: 'rpm',
          reason: 'package-install-failed',
          version: '1.0.61'
        }
      })
      expect(killAllPtyMock).not.toHaveBeenCalled()
      expect(openWindow.removeAllListeners).not.toHaveBeenCalled()
      expect(updater.isQuittingForUpdate()).toBe(false)
      expect(disarmExitWatchdogMock).toHaveBeenCalled()
    })

    it('keeps the generic install-failure copy when no artifact was retained', async () => {
      const { send, updater } = await startUpdater('deb')
      // Release metadata without a digest must not enable cached-package recovery.
      await reachDownloaded(
        updater,
        downloadedEvent({ files: [{ url: 'orca-ide_1.0.61_amd64.deb' }] })
      )
      autoUpdaterMock.quitAndInstall.mockImplementation(() => {
        autoUpdaterMock.emit('error', new Error(EXIT_127))
      })

      updater.quitAndInstall()
      await settleQuitAndInstall()

      expect(send).toHaveBeenCalledWith('updater:status', {
        state: 'error',
        message: `${PRE_COMMIT_FAILURE_MESSAGE} (${EXIT_127})`
      })
      expect(recordUpdaterLifecycleMock).not.toHaveBeenCalledWith(
        'linux_package_install_failed',
        expect.anything(),
        expect.anything()
      )
    })

    it('advises a restart only for a failure before the native invoke', async () => {
      const { send, updater } = await startUpdater('deb')
      await reachDownloaded(updater, downloadedEvent())
      // The source calls this out as the pre-native "cleanup/tracing exception" case.
      recordUpdaterLifecycleMock.mockImplementation((event: unknown) => {
        if (event === 'quit_and_install_invoking_native') {
          throw new Error('tracing sink unavailable')
        }
      })

      updater.quitAndInstall()
      await settleQuitAndInstall()

      expect(autoUpdaterMock.quitAndInstall).not.toHaveBeenCalled()
      expect(send).toHaveBeenCalledWith('updater:status', {
        state: 'error',
        message: 'Could not restart to install the update. Quit and reopen Orca, then try again.'
      })
      expect(updater.isQuittingForUpdate()).toBe(false)
    })

    it('keeps a committed install intact when post-commit cleanup throws', async () => {
      const { send, updater } = await startUpdater('deb')
      await reachDownloaded(updater, downloadedEvent())
      // Why: spawnSync already installed the package; a teardown throw must not be reported as failure.
      killAllPtyMock.mockImplementation(() => {
        throw new Error('pty teardown failed')
      })
      send.mockClear()

      updater.quitAndInstall()
      await settleQuitAndInstall()

      expect(recordUpdaterLifecycleMock).toHaveBeenCalledWith(
        'post_commit_cleanup_failed',
        { errorType: 'Error' },
        expect.objectContaining({ level: 'warn' })
      )
      expect(send).not.toHaveBeenCalled()
      expect(updater.isQuittingForUpdate()).toBe(true)
      expect(armExitWatchdogMock).toHaveBeenCalledTimes(1)
      expect(disarmExitWatchdogMock).not.toHaveBeenCalled()
    })

    it('still suppresses late post-commit errors while an artifact is retained', async () => {
      const { send, updater } = await startUpdater('deb')
      await reachDownloaded(updater, downloadedEvent())

      updater.quitAndInstall()
      await settleQuitAndInstall()
      expect(killAllPtyMock).toHaveBeenCalledTimes(1)

      send.mockClear()
      autoUpdaterMock.emit('error', new Error(EXIT_127))

      expect(send).not.toHaveBeenCalled()
      expect(updater.isQuittingForUpdate()).toBe(true)
    })

    it('retries the automatic install without redownloading the package', async () => {
      const { send, updater } = await startUpdater('deb')
      await reachDownloaded(updater, downloadedEvent())
      autoUpdaterMock.quitAndInstall.mockImplementation(() => {
        autoUpdaterMock.emit('error', new Error(EXIT_127))
      })

      updater.quitAndInstall()
      await settleQuitAndInstall()
      updater.quitAndInstall()
      await settleQuitAndInstall()

      // Why: a retry usually fails identically; a deduped status would strand the preload restart relay.
      expect(
        send.mock.calls.filter(
          ([channel, status]) =>
            channel === 'updater:status' &&
            (status as { recovery?: { kind?: string } })?.recovery?.kind === 'linux-package-install'
        )
      ).toHaveLength(2)
      expect(autoUpdaterMock.quitAndInstall).toHaveBeenCalledTimes(2)
      expect(autoUpdaterMock.downloadUpdate).not.toHaveBeenCalled()
      expect(recordUpdaterLifecycleMock).toHaveBeenCalledWith('linux_package_recovery_requested', {
        action: 'retry-automatic',
        packageType: 'deb',
        version: '1.0.61'
      })
    })

    // Why: the cache path is user-writable, so the bytes verified when the recovery card
    // rendered are not necessarily the bytes a root package manager would read on retry.
    it('aborts the retry when the retained package no longer matches its digest', async () => {
      const { send, updater } = await startUpdater('deb')
      await reachDownloaded(updater, downloadedEvent())

      // The escalation fails, which is what puts the recovery card (and its retry) on screen.
      autoUpdaterMock.quitAndInstall.mockImplementation(() => {
        autoUpdaterMock.emit('error', new Error(EXIT_127))
      })
      updater.quitAndInstall()
      await settleQuitAndInstall()
      expect(autoUpdaterMock.quitAndInstall).toHaveBeenCalledTimes(1)

      // A local process swaps the verified package for its own between failure and retry.
      writeFileSync(staged.debPath, Buffer.from('attacker supplied package'))
      send.mockClear()
      killAllPtyMock.mockClear()

      updater.quitAndInstall()
      await settleQuitAndInstall()

      expect(autoUpdaterMock.quitAndInstall).toHaveBeenCalledTimes(1)
      expect(killAllPtyMock).not.toHaveBeenCalled()
      expect(updater.isQuittingForUpdate()).toBe(false)
      expect(send).toHaveBeenCalledWith('updater:status', {
        state: 'error',
        message:
          'The downloaded package no longer matches the verified release, so Orca will not hand it to a package manager. Download the update again, or get it from the official release page.'
      })
      expect(recordUpdaterLifecycleMock).toHaveBeenCalledWith(
        'linux_package_revalidation_failed',
        expect.objectContaining({ action: 'retry-automatic', reason: 'hash-mismatch' }),
        expect.anything()
      )
    })

    // Why: "Restart to Update" is the common path and can sit unclicked for hours, so the same
    // user-writable package reaches a root installer with a far longer window than any retry.
    it('aborts the first install when the downloaded package was swapped', async () => {
      const { send, updater } = await startUpdater('deb')
      await reachDownloaded(updater, downloadedEvent())
      writeFileSync(staged.debPath, Buffer.from('attacker supplied package'))
      send.mockClear()

      updater.quitAndInstall()
      await settleQuitAndInstall()

      expect(autoUpdaterMock.quitAndInstall).not.toHaveBeenCalled()
      expect(killAllPtyMock).not.toHaveBeenCalled()
      expect(updater.isQuittingForUpdate()).toBe(false)
      expect(send).toHaveBeenCalledWith('updater:status', {
        state: 'error',
        message:
          'The downloaded package no longer matches the verified release, so Orca will not hand it to a package manager. Download the update again, or get it from the official release page.'
      })
      expect(send).toHaveBeenCalledWith('updater:quitAndInstallAborted')
      expect(recordUpdaterLifecycleMock).toHaveBeenCalledWith(
        'linux_package_revalidation_failed',
        expect.objectContaining({ action: 'restart-to-install', reason: 'hash-mismatch' }),
        expect.anything()
      )
    })

    it('installs normally when the retained package still matches its digest', async () => {
      const { send, updater } = await startUpdater('deb')
      await reachDownloaded(updater, downloadedEvent())

      updater.quitAndInstall()
      await settleQuitAndInstall()

      expect(autoUpdaterMock.quitAndInstall).toHaveBeenCalledTimes(1)
      expect(killAllPtyMock).toHaveBeenCalledTimes(1)
      // Why: an abort push here would clear the restart flag mid-quit and re-arm the dirty-buffer
      // prompt against the install that is already committed.
      expect(send).not.toHaveBeenCalledWith('updater:quitAndInstallAborted')
      expect(recordUpdaterLifecycleMock).not.toHaveBeenCalledWith(
        'linux_package_revalidation_failed',
        expect.anything(),
        expect.anything()
      )
    })

    // Why: hashing 160 MB outlives the cycle it started in, and Check for Updates stays enabled
    // while it runs — a verdict from the old cycle must not replace the card that took over.
    it('drops an abort verdict once a newer check replaced the card', async () => {
      revalidation.hold()
      const { send, updater } = await startUpdater('deb')
      await reachDownloaded(updater, downloadedEvent())

      updater.quitAndInstall()
      await vi.advanceTimersByTimeAsync(100)
      // The user gives up waiting and checks again; that check owns the card from here.
      updater.checkForUpdatesFromMenu()
      await vi.advanceTimersByTimeAsync(0)
      expect(lastStatus(send)).toMatchObject({ state: 'available', version: '1.0.61' })

      revalidation.settle({ ok: false, reason: 'hash-mismatch' })
      await settleQuitAndInstall()

      // The install is still abandoned — only the stale status is withheld.
      expect(autoUpdaterMock.quitAndInstall).not.toHaveBeenCalled()
      expect(lastStatus(send)).toMatchObject({ state: 'available', version: '1.0.61' })
      // Withholding the status must not also withhold the abort: the renderer armed its restart and
      // would otherwise skip its unsaved-work prompt for the rest of the session.
      expect(send).toHaveBeenCalledWith('updater:quitAndInstallAborted')
      expect(recordUpdaterLifecycleMock).toHaveBeenCalledWith(
        'linux_package_revalidation_failed',
        expect.objectContaining({ reason: 'hash-mismatch' }),
        expect.anything()
      )
    })

    // Why: EMFILE/EIO during the stream says nothing about the bytes, so the copy must not claim
    // the package changed and the card must keep the actions that still work.
    it('keeps the recovery card usable when the re-proof cannot read the package', async () => {
      revalidation.hold()
      const { send, updater } = await startUpdater('deb')
      await reachDownloaded(updater, downloadedEvent())
      autoUpdaterMock.quitAndInstall.mockImplementation(() => {
        autoUpdaterMock.emit('error', new Error(EXIT_127))
      })
      updater.quitAndInstall()
      await vi.advanceTimersByTimeAsync(100)
      revalidation.settle({ ok: true })
      await settleQuitAndInstall()
      send.mockClear()

      updater.quitAndInstall()
      await vi.advanceTimersByTimeAsync(100)
      revalidation.settle({ ok: false, reason: 'read-failed' })
      await settleQuitAndInstall()

      expect(autoUpdaterMock.quitAndInstall).toHaveBeenCalledTimes(1)
      expect(lastStatus(send)).toEqual({
        state: 'error',
        message:
          'Orca could not read the downloaded package. Download the update again, or get it from the official release page.',
        recovery: {
          kind: 'linux-package-install',
          packageType: 'deb',
          reason: 'package-install-failed',
          version: '1.0.61'
        }
      })
    })

    // Why: the re-proof runs before performQuitAndInstall's own error handling, so a rejection
    // there would strand the quit timer and make every later install a silent no-op.
    it('stays installable after a re-proof that rejects outright', async () => {
      revalidation.hold()
      const { send, updater } = await startUpdater('deb')
      await reachDownloaded(updater, downloadedEvent())

      updater.quitAndInstall()
      await vi.advanceTimersByTimeAsync(100)
      revalidation.fail(new Error('hash worker crashed'))
      await settleQuitAndInstall()

      // Fails closed: an unprovable package is not handed to a root package manager.
      expect(autoUpdaterMock.quitAndInstall).not.toHaveBeenCalled()
      expect(lastStatus(send)).toMatchObject({
        state: 'error',
        message:
          'Orca could not read the downloaded package. Download the update again, or get it from the official release page.'
      })

      updater.quitAndInstall()
      await vi.advanceTimersByTimeAsync(100)
      revalidation.settle({ ok: true })
      await settleQuitAndInstall()

      expect(autoUpdaterMock.quitAndInstall).toHaveBeenCalledTimes(1)
    })

    // Why: a second click during the multi-second hash must not schedule a parallel install.
    it('ignores a second install request while the digest re-proof runs', async () => {
      revalidation.hold()
      const { updater } = await startUpdater('deb')
      await reachDownloaded(updater, downloadedEvent())

      updater.quitAndInstall()
      // Fires the quit timer, which starts the re-proof; its verdict is still outstanding.
      await vi.advanceTimersByTimeAsync(100)
      expect(revalidation.invocationCount()).toBe(1)
      updater.quitAndInstall()
      // Advancing here proves the second request never scheduled its own quit timer.
      await vi.advanceTimersByTimeAsync(100)
      expect(revalidation.invocationCount()).toBe(1)
      revalidation.settle({ ok: true })
      await settleQuitAndInstall()

      expect(autoUpdaterMock.quitAndInstall).toHaveBeenCalledTimes(1)
    })

    it('records classification-only lifecycle data for a package install failure', async () => {
      const { updater } = await startUpdater('deb')
      await reachDownloaded(updater, downloadedEvent())
      autoUpdaterMock.quitAndInstall.mockImplementation(() => {
        autoUpdaterMock.logger?.error(`${AGENT_STDERR} target ${staged.debPath}`)
        autoUpdaterMock.emit('error', new Error(EXIT_127))
      })

      updater.quitAndInstall()
      await settleQuitAndInstall()

      const failure = recordUpdaterLifecycleMock.mock.calls.find(
        ([event]) => event === 'linux_package_install_failed'
      )
      expect(failure?.[1]).toEqual({
        packageType: 'deb',
        reason: 'authentication-agent-unavailable',
        exitCode: 127,
        version: '1.0.61',
        errorType: 'Error'
      })
      const durable = JSON.stringify(recordUpdaterLifecycleMock.mock.calls)
      expect(durable).not.toContain(staged.debPath)
      expect(durable).not.toContain('authentication agent')
    })

    it('omits exitCode from lifecycle data when the child status is unparseable', async () => {
      const { updater } = await startUpdater('deb')
      await reachDownloaded(updater, downloadedEvent())
      autoUpdaterMock.quitAndInstall.mockImplementation(() => {
        autoUpdaterMock.emit('error', new Error('dpkg was interrupted'))
      })

      updater.quitAndInstall()
      await settleQuitAndInstall()

      const failure = recordUpdaterLifecycleMock.mock.calls.find(
        ([event]) => event === 'linux_package_install_failed'
      )
      // Why: an absent key, not an explicit null, keeps the breadcrumb schema honest.
      expect(failure?.[1]).toEqual({
        packageType: 'deb',
        reason: 'package-install-failed',
        version: '1.0.61',
        errorType: 'Error'
      })
      expect(Object.keys(failure?.[1] as object)).not.toContain('exitCode')
    })
  })
})
