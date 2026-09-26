import { describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => {
  const events: string[] = []
  // Why a two-word app token: this file sets the dev app name to "Orca Development", and Electron
  // builds the app token from that name. A single-token fixture could not exhibit the multi-word
  // leak the cleaner exists to handle, so it disagreed with the scenario it set up.
  // Why the engine comment: a real app.userAgentFallback always carries it, and the cleaner only
  // touches identities that do — a fixture without it models a string Electron cannot produce.
  let userAgent =
    'Mozilla/5.0 (Test) AppleWebKit/537.36 (KHTML, like Gecko) Orca Development/0.0.0 Chrome/150.0.0.0 Electron/43.0.0 Safari/537.36'
  const app = {
    isPackaged: false,
    exit: vi.fn(),
    getVersion: vi.fn(() => '1.0.0'),
    getPath: vi.fn(() => '/canonical-user-data'),
    get userAgentFallback(): string {
      events.push('read-user-agent')
      return userAgent
    },
    set userAgentFallback(value: string) {
      events.push('write-user-agent')
      userAgent = value
    },
    isReady: vi.fn(() => {
      events.push('is-ready')
      return false
    }),
    whenReady: vi.fn(() => Promise.resolve()),
    setName: vi.fn((name: string) => {
      events.push(`set-name:${name}`)
    })
  }
  return {
    app,
    events,
    userAgent: () => userAgent,
    showErrorBox: vi.fn(),
    backgroundLaunch: vi.fn(() => true),
    admission: vi.fn(),
    lock: vi.fn(() => true),
    afterIdentity: vi.fn((): void => {
      throw new Error('preflight-test-stop')
    }),
    recoverMoves: vi.fn()
  }
})

vi.mock('electron', () => ({
  app: mocks.app,
  dialog: { showErrorBox: mocks.showErrorBox },
  ipcMain: {},
  powerMonitor: {},
  session: { defaultSession: {} }
}))
vi.mock('../window/foreground-activation-policy', () => ({
  isBackgroundLaunch: mocks.backgroundLaunch
}))
vi.mock('@electron-toolkit/utils', () => ({ is: { dev: true } }))
vi.mock('./cli-launch-redirect', () => ({
  maybeRedirectCliLaunch: () => ({ redirected: false, status: 0 })
}))
vi.mock('./serve-mode-argv', () => ({
  argvRequestsServeMode: () => false,
  normalizeServeModeArgv: (argv: string[]) => argv
}))
vi.mock('./configure-process', () => ({
  configureDevUserDataPath: vi.fn(),
  configureElectronNetworkCompatibility: vi.fn(),
  configureOrcaUserDataPathEnv: vi.fn(),
  disableUnsupportedChromiumFeatures: vi.fn(),
  enableMainProcessGpuFeatures: vi.fn(),
  installDevParentDisconnectQuit: vi.fn(),
  installDevParentSignalQuit: vi.fn(),
  installDevParentWatchdog: vi.fn(),
  optOutOfHiddenPageWakeUpThrottling: vi.fn(),
  patchPackagedProcessPath: vi.fn()
}))
vi.mock('../serve-update-handoff', () => ({ installServeSupervisorDisconnectQuit: vi.fn() }))
vi.mock('./main-process-error-guards', () => ({
  installUncaughtPipeErrorGuard: vi.fn(),
  installUnhandledRejectionLogging: vi.fn()
}))
vi.mock('./hydrate-shell-path')
vi.mock('../runtime/remote-server-updater', () => ({ configureRemoteServerUpdater: vi.fn() }))
vi.mock('../updater', () => ({
  getRemoteServerUpdaterSnapshot: vi.fn(),
  checkForRemoteServerUpdate: vi.fn(),
  downloadRemoteServerUpdate: vi.fn(),
  installRemoteServerUpdate: vi.fn(),
  isQuittingForUpdate: () => false
}))
vi.mock('./dev-instance-identity', () => ({
  getDevInstanceIdentity: () => ({
    isDev: true,
    appName: 'Orca Development',
    appUserModelId: 'com.orca.development'
  }),
  shouldApplyPreReadyAppName: () => true
}))
vi.mock('./renderer-heap-headroom')
vi.mock('./startup-diagnostics', () => ({
  isStartupDiagnosticsEnabled: () => false,
  logStartupDiagnostic: vi.fn()
}))
vi.mock('./event-loop-stall-probe')
vi.mock('../diagnostics/main-thread-churn-probe')
vi.mock('../git/source-control/git-read-cache-invalidation', () => ({
  settledDiffCache: { stats: vi.fn() }
}))
vi.mock('../server/serve-stdout-boundary')
vi.mock('./serve-desktop-activation', () => ({
  createServeDesktopActivationGate: () => ({})
}))
vi.mock('./single-instance-lock', () => ({
  shouldBypassSingleInstanceLock: () => false,
  shouldSkipSingleInstanceLock: () => false,
  acquireSingleInstanceLock: () => {
    mocks.events.push('single-instance-lock')
    return mocks.lock()
  },
  logSingleInstanceLockBypass: vi.fn(),
  logSingleInstanceLockFailure: vi.fn(),
  SINGLE_INSTANCE_ALREADY_RUNNING_EXIT_CODE: 1
}))
vi.mock('../../shared/app-environment', () => ({ setAppEnvironment: vi.fn() }))
vi.mock('../host/electron-app-environment', () => ({ ElectronAppEnvironment: class {} }))
vi.mock('../own-chromium-tree-kill-guard')
vi.mock('../../shared/secret-store', () => ({
  setSecretStore: () => {
    mocks.events.push('continued-after-browser-identity')
    mocks.afterIdentity()
  }
}))
vi.mock('../host/electron-secret-store')
vi.mock('../ipc/pty-host-bindings')
vi.mock('../host/electron-runtime-desktop-surface')
vi.mock('../runtime/runtime-desktop-surface')
vi.mock('../host/electron-browser-commands')
vi.mock('../runtime/runtime-browser-commands-factory')
vi.mock('../host/electron-http-client')
vi.mock('../network/http-client')
vi.mock('../host/electron-speech-services')
vi.mock('../speech/speech-runtime-service')
vi.mock('../ipc/worktree-watcher-removal')
vi.mock('../ipc/filesystem-watcher')
vi.mock('../network/proxy-settings')
vi.mock('../persistence', () => ({
  initDataPath: () => mocks.events.push('init-data-path'),
  getCanonicalUserDataPath: () => '/canonical-user-data'
}))
vi.mock('../persistence/profile-state/profile-state-access', () => ({
  acquireProfileStateRuntimeAdmission: (root: string) => {
    mocks.events.push(`admission:${root}`)
    return mocks.admission()
  }
}))
vi.mock('../macos-press-and-hold-default')
vi.mock('../ai-vault/session-parse-cache-persistence')
vi.mock('../orca-profiles/profile-index-store', () => ({ initOrcaProfilePaths: vi.fn() }))
vi.mock('../orca-profiles/profile-storage-paths', () => ({
  getProfileUserDataPath: () => '/canonical-user-data'
}))
vi.mock('../orca-profiles/profile-project-move-intent', () => ({
  recoverPendingProfileProjectMoves: mocks.recoverMoves
}))
vi.mock('../persistence/profile-state/profile-state-active-location', () => ({
  getActiveProfileStateLocation: () => ({ profileId: 'active-profile' })
}))
vi.mock('../stats/collector')
vi.mock('../claude-usage/store')
vi.mock('../codex-usage/store')
vi.mock('../opencode-usage/store')
vi.mock('../browser/doc-preview-protocol')
vi.mock('../crash-reporting/crashpad-capture')
vi.mock('../crash-reporting/crash-report-store')
vi.mock('../crash-reporting/crash-breadcrumb-store')
vi.mock('../crash-reporting/durable-crash-breadcrumb')
vi.mock('../crash-reporting/gpu-crash-diagnostics')
vi.mock('../crash-reporting/main-process-lifecycle-identity')
vi.mock('./ensure-virtual-display', () => ({
  ensureVirtualDisplayForHeadlessServe: vi.fn(),
  hasUsableLinuxDisplay: () => true,
  MISSING_LINUX_DISPLAY_MESSAGE: 'missing display'
}))
vi.mock('./gpu-lifecycle')
vi.mock('./main-process-state', () => ({ mainProcessState: {} }))
vi.mock('./synthetic-title-runtime')
vi.mock('../browser/browser-identity-mode-store', () => ({
  initializeBrowserIdentityModeStore: (path: string) => {
    mocks.events.push(`read-mode:${path}`)
    return {
      state: 'valid',
      appliedMode: 'clean',
      configuredMode: 'clean',
      explicitSelection: true,
      migrationNoticePending: false
    }
  }
}))

describe('browser process user-agent startup ordering', () => {
  it('explains admission refusal before a desktop launch exits', async () => {
    const { runMainProcessPreflight } = await import('./main-process-preflight')
    const platform = vi.spyOn(process, 'platform', 'get').mockReturnValue('darwin')
    mocks.backgroundLaunch.mockReturnValueOnce(false)
    mocks.admission.mockImplementationOnce(() => {
      throw new Error('Stop Orca and orcad before retrying profile recovery')
    })
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      expect(
        runMainProcessPreflight({ focusExistingWindow: vi.fn(), requestDesktopActivation: vi.fn() })
      ).toBe(false)
      expect(mocks.showErrorBox).toHaveBeenCalledWith(
        'Orca could not start',
        expect.stringContaining('Stop Orca and orcad before retrying profile recovery')
      )
      expect(mocks.app.isReady).not.toHaveBeenCalled()
    } finally {
      error.mockRestore()
      platform.mockRestore()
      mocks.showErrorBox.mockClear()
      mocks.events.length = 0
    }
  })

  it('does not acquire profile admission for a duplicate launch', async () => {
    const { runMainProcessPreflight } = await import('./main-process-preflight')
    mocks.events.length = 0
    mocks.lock.mockReturnValueOnce(false)
    expect(
      runMainProcessPreflight({ focusExistingWindow: vi.fn(), requestDesktopActivation: vi.fn() })
    ).toBe(false)
    expect(mocks.events).not.toContain('admission:/canonical-user-data')
    expect(mocks.events).not.toContain('read-mode:/canonical-user-data')
    expect(mocks.app.exit).toHaveBeenCalledWith(1)
    mocks.events.length = 0
  })

  it('executes after the dev app name and before later preflight work', async () => {
    const { getBrowserProcessUserAgentIdentity } =
      await import('../browser/browser-process-user-agent')
    const { runMainProcessPreflight } = await import('./main-process-preflight')

    expect(
      runMainProcessPreflight({
        focusExistingWindow: vi.fn(),
        requestDesktopActivation: vi.fn()
      })
    ).toBe(false)

    const nameIndex = mocks.events.indexOf('set-name:Orca Development')
    const modeIndex = mocks.events.indexOf('read-mode:/canonical-user-data')
    const writeIndex = mocks.events.indexOf('write-user-agent')
    const continuationIndex = mocks.events.indexOf('continued-after-browser-identity')
    expect(mocks.events.indexOf('init-data-path')).toBeLessThan(nameIndex)
    expect(mocks.events.indexOf('init-data-path')).toBeLessThan(
      mocks.events.indexOf('admission:/canonical-user-data')
    )
    expect(mocks.events.indexOf('admission:/canonical-user-data')).toBeLessThan(modeIndex)
    expect(nameIndex).toBeLessThan(modeIndex)
    expect(modeIndex).toBeLessThan(writeIndex)
    expect(writeIndex).toBeLessThan(continuationIndex)
    expect(getBrowserProcessUserAgentIdentity()).toEqual({
      mode: 'clean',
      userAgent: mocks.userAgent()
    })
    // Both app-name words must be gone, not just the last: a single \S+ would have left "Orca".
    expect(mocks.userAgent()).not.toMatch(/Electron/)
    expect(mocks.userAgent()).not.toMatch(/Orca|Development/)
  })

  it('exits without reading profile state or revealing a window when recovery holds admission', async () => {
    const { runMainProcessPreflight } = await import('./main-process-preflight')
    mocks.events.length = 0
    mocks.admission.mockImplementationOnce(() => {
      throw new Error('Profile recovery is in progress')
    })
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    const focusExistingWindow = vi.fn()
    const requestDesktopActivation = vi.fn()
    try {
      expect(runMainProcessPreflight({ focusExistingWindow, requestDesktopActivation })).toBe(false)
      expect(mocks.app.exit).toHaveBeenCalledWith(1)
      expect(mocks.events).toEqual([
        'init-data-path',
        'set-name:Orca Development',
        'single-instance-lock',
        'admission:/canonical-user-data'
      ])
      expect(focusExistingWindow).not.toHaveBeenCalled()
      expect(requestDesktopActivation).not.toHaveBeenCalled()
      expect(mocks.showErrorBox).not.toHaveBeenCalled()
    } finally {
      error.mockRestore()
    }
  })
})

it('exits and releases admission after pending profile move recovery fails', async () => {
  const { resetBrowserProcessUserAgentForTests } =
    await import('../browser/browser-process-user-agent')
  resetBrowserProcessUserAgentForTests()
  const release = vi.fn()
  mocks.admission.mockReturnValueOnce({ release })
  mocks.afterIdentity.mockImplementationOnce(() => undefined)
  mocks.recoverMoves.mockImplementationOnce(() => {
    throw new Error('unreadable move journal')
  })
  const { runMainProcessPreflight } = await import('./main-process-preflight')
  expect(
    runMainProcessPreflight({ focusExistingWindow: vi.fn(), requestDesktopActivation: vi.fn() })
  ).toBe(false)
  expect(mocks.recoverMoves).toHaveBeenCalledWith('/canonical-user-data', 'active-profile')
  expect(release).toHaveBeenCalledOnce()
  expect(mocks.app.exit).toHaveBeenCalledWith(1)
})

it('defers a Linux desktop startup failure until Electron is ready', async () => {
  const { runMainProcessPreflight } = await import('./main-process-preflight')
  const { resetBrowserProcessUserAgentForTests } =
    await import('../browser/browser-process-user-agent')
  resetBrowserProcessUserAgentForTests()
  const release = vi.fn()
  let resolveReady: (() => void) | undefined
  const ready = new Promise<void>((resolve) => {
    resolveReady = resolve
  })
  mocks.admission.mockReturnValueOnce({ release })
  mocks.afterIdentity.mockImplementationOnce(() => {
    throw new Error('Linux pre-ready failure')
  })
  mocks.app.whenReady.mockReturnValueOnce(ready)
  mocks.app.exit.mockClear()
  mocks.showErrorBox.mockClear()
  const platform = vi.spyOn(process, 'platform', 'get').mockReturnValue('linux')
  mocks.backgroundLaunch.mockReturnValueOnce(false)
  const error = vi.spyOn(console, 'error').mockImplementation(() => {})
  try {
    expect(
      runMainProcessPreflight({ focusExistingWindow: vi.fn(), requestDesktopActivation: vi.fn() })
    ).toBe(false)
    expect(release).toHaveBeenCalledOnce()
    expect(mocks.app.whenReady).toHaveBeenCalledOnce()
    expect(mocks.showErrorBox).not.toHaveBeenCalled()
    expect(mocks.app.exit).not.toHaveBeenCalled()

    resolveReady?.()
    await ready
    await Promise.resolve()
    expect(mocks.showErrorBox).toHaveBeenCalledWith(
      'Orca could not start',
      expect.stringContaining('Linux pre-ready failure')
    )
    expect(mocks.app.exit).toHaveBeenCalledWith(1)
  } finally {
    error.mockRestore()
    platform.mockRestore()
    mocks.app.whenReady.mockClear()
  }
})

it('exits after a Linux desktop readiness rejection without showing a dialog', async () => {
  const { runMainProcessPreflight } = await import('./main-process-preflight')
  const { resetBrowserProcessUserAgentForTests } =
    await import('../browser/browser-process-user-agent')
  resetBrowserProcessUserAgentForTests()
  const release = vi.fn()
  let rejectReady!: (error: Error) => void
  const ready = new Promise<void>((_resolve, reject) => {
    rejectReady = reject
  })
  mocks.admission.mockReturnValueOnce({ release })
  mocks.afterIdentity.mockImplementationOnce(() => {
    throw new Error('Linux pre-ready failure')
  })
  mocks.app.whenReady.mockReturnValueOnce(ready)
  mocks.app.exit.mockClear()
  mocks.showErrorBox.mockClear()
  const platform = vi.spyOn(process, 'platform', 'get').mockReturnValue('linux')
  mocks.backgroundLaunch.mockReturnValueOnce(false)
  const error = vi.spyOn(console, 'error').mockImplementation(() => {})
  try {
    expect(
      runMainProcessPreflight({ focusExistingWindow: vi.fn(), requestDesktopActivation: vi.fn() })
    ).toBe(false)
    expect(release).toHaveBeenCalledOnce()
    rejectReady(new Error('Electron readiness failed'))
    await ready.catch(() => undefined)
    await Promise.resolve()
    expect(mocks.showErrorBox).not.toHaveBeenCalled()
    expect(mocks.app.exit).toHaveBeenCalledWith(1)
  } finally {
    error.mockRestore()
    platform.mockRestore()
    mocks.app.whenReady.mockClear()
  }
})

it('keeps Linux background startup failures console-only and immediate', async () => {
  const { runMainProcessPreflight } = await import('./main-process-preflight')
  const { resetBrowserProcessUserAgentForTests } =
    await import('../browser/browser-process-user-agent')
  resetBrowserProcessUserAgentForTests()
  const release = vi.fn()
  mocks.admission.mockReturnValueOnce({ release })
  mocks.afterIdentity.mockImplementationOnce(() => {
    throw new Error('Linux background failure')
  })
  mocks.app.whenReady.mockClear()
  mocks.app.exit.mockClear()
  mocks.showErrorBox.mockClear()
  const platform = vi.spyOn(process, 'platform', 'get').mockReturnValue('linux')
  mocks.backgroundLaunch.mockReturnValueOnce(true)
  const error = vi.spyOn(console, 'error').mockImplementation(() => {})
  try {
    expect(
      runMainProcessPreflight({ focusExistingWindow: vi.fn(), requestDesktopActivation: vi.fn() })
    ).toBe(false)
    expect(release).toHaveBeenCalledOnce()
    expect(mocks.app.whenReady).not.toHaveBeenCalled()
    expect(mocks.showErrorBox).not.toHaveBeenCalled()
    expect(mocks.app.exit).toHaveBeenCalledWith(1)
  } finally {
    error.mockRestore()
    platform.mockRestore()
  }
})

it('keeps Linux serve startup failures console-only and immediate', async () => {
  const { runMainProcessPreflight } = await import('./main-process-preflight')
  const { resetBrowserProcessUserAgentForTests } =
    await import('../browser/browser-process-user-agent')
  resetBrowserProcessUserAgentForTests()
  const release = vi.fn()
  const originalArgv = process.argv
  process.argv = originalArgv.includes('--serve') ? [...originalArgv] : [...originalArgv, '--serve']
  mocks.admission.mockReturnValueOnce({ release })
  mocks.afterIdentity.mockImplementationOnce(() => {
    throw new Error('Linux serve failure')
  })
  mocks.app.whenReady.mockClear()
  mocks.app.exit.mockClear()
  mocks.showErrorBox.mockClear()
  const platform = vi.spyOn(process, 'platform', 'get').mockReturnValue('linux')
  mocks.backgroundLaunch.mockReturnValueOnce(false)
  const error = vi.spyOn(console, 'error').mockImplementation(() => {})
  try {
    expect(
      runMainProcessPreflight({ focusExistingWindow: vi.fn(), requestDesktopActivation: vi.fn() })
    ).toBe(false)
    expect(release).toHaveBeenCalledOnce()
    expect(mocks.app.whenReady).not.toHaveBeenCalled()
    expect(mocks.showErrorBox).not.toHaveBeenCalled()
    expect(mocks.app.exit).toHaveBeenCalledWith(1)
  } finally {
    error.mockRestore()
    platform.mockRestore()
    process.argv = originalArgv
  }
})
