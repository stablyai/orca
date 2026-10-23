import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type * as DurableFileWrite from '../durable-file-write'
import { JIRA_IMAGE_SCHEME } from '../../shared/jira/jira-attachment-image'

const ORIGINAL_PLATFORM = process.platform
const ORCA_PROFILE_ID = 'local-default'
const RETIRED_PROFILE_ID = '11111111-1111-4111-8111-111111111111'

const mocks = vi.hoisted(() => ({
  // Assigned in beforeAll; the factories below read them lazily, so real directories exist by the
  // time ready composition resolves the canonical userData path and the active profile directory.
  userDataPath: '',
  isPackaged: false,
  setAppUserModelId: vi.fn(),
  profileDirectory: '',
  state: {
    devInstanceIdentity: { appUserModelId: 'app.id', appName: 'Orca' },
    isServeMode: false,
    mainProcessI18nReady: Promise.resolve(),
    managedWslCliReconciliationStatus: 'settled',
    initialProxyApplicationReady: Promise.resolve(),
    hangDetection: null,
    store: null
  },
  openMainWindow: vi.fn(),
  handleProtocol: vi.fn(),
  runtimeRpcStart: vi.fn(async () => {}),
  // The identity record's only writer. Watching this is what makes the pin real: asserting on
  // writeFileAtomically watched a function the identity store never calls.
  writeFileDurableSync: vi.fn()
}))

vi.mock('../durable-file-write', async (importOriginal) => {
  const actual = await importOriginal<typeof DurableFileWrite>()
  return {
    ...actual,
    // Records and then really writes: the registry path below must land on disk so
    // readBrowserIdentityModeRecord is reading what ready actually produced.
    writeFileDurableSync: (...args: Parameters<typeof actual.writeFileDurableSync>) => {
      mocks.writeFileDurableSync(...args)
      actual.writeFileDurableSync(...args)
    }
  }
})

vi.mock('electron', () => ({
  protocol: { handle: mocks.handleProtocol },
  app: {
    on: vi.fn(),
    setName: vi.fn(),
    getPath: vi.fn(() => mocks.userDataPath),
    getVersion: vi.fn(() => '1.0.0'),
    get isPackaged() {
      return mocks.isPackaged
    },
    setAppUserModelId: mocks.setAppUserModelId
  },
  session: {
    defaultSession: {},
    fromPartition: vi.fn(() => ({
      setUserAgent: vi.fn(),
      getUserAgent: vi.fn(() => 'Mozilla/5.0 Test'),
      setPermissionRequestHandler: vi.fn(),
      setPermissionCheckHandler: vi.fn(),
      setDisplayMediaRequestHandler: vi.fn(),
      on: vi.fn(),
      removeListener: vi.fn()
    }))
  }
}))
vi.mock('./main-process-state', () => ({ mainProcessState: mocks.state }))
vi.mock('../persistence', () => ({
  Store: class {
    getSettings() {
      return {}
    }
    onSettingsChanged() {}
    getUI() {
      return {}
    }
    onUIChanged() {}
    getSshTargets() {
      return []
    }
  },
  getCanonicalUserDataPath: () => mocks.userDataPath
}))
vi.mock('../persistence/profile-state/profile-state-startup-authority', () => ({
  createProfileStateStoreForStartup: () => ({
    store: {
      getSettings: () => ({}),
      onSettingsChanged: () => {},
      getUI: () => ({}),
      onUIChanged: () => {},
      getSshTargets: () => []
    }
  })
}))
// The registry reads the canonical path from this module, not from '../persistence'.
vi.mock('../persistence/loading-store/user-data-path', () => ({
  getCanonicalUserDataPath: () => mocks.userDataPath
}))
vi.mock('../window/foreground-activation-policy', () => ({
  applyBackgroundActivationPolicy: vi.fn()
}))
vi.mock('../network/proxy-settings', () => ({
  applyElectronProxySettings: vi.fn(async () => ({ source: 'direct' })),
  retireProxySessionApplication: vi.fn()
}))
vi.mock('../network/electron-proxy-request-guard', () => ({
  installElectronProxyRequestGuard: vi.fn()
}))
vi.mock('../network/electron-proxy-credentials', () => ({ handleElectronProxyLogin: vi.fn() }))
vi.mock('../hang-watchdog/main-thread-hang-watchdog', () => ({
  installMainThreadHangWatchdog: vi.fn()
}))
vi.mock('../hang-watchdog/hang-detection-marker', () => ({
  consumeHangDetectionMarker: vi.fn(() => null),
  hangDetectionMarkerPath: vi.fn(() => '/test-marker')
}))
vi.mock('../browser/browser-manager', () => ({
  browserCertificateTrustController: {},
  browserManager: {
    installCertificateRequestGuard: vi.fn(),
    removeCertificateRequestGuard: vi.fn(),
    notifyPermissionDenied: vi.fn(),
    handleGuestWillDownload: vi.fn(),
    setSiteDisplayController: vi.fn()
  }
}))
vi.mock('../orca-profiles/profile-index-store', () => ({
  ensureActiveOrcaProfile: () => ({
    profile: { id: ORCA_PROFILE_ID },
    profileDirectory: mocks.profileDirectory,
    dataFile: join(mocks.profileDirectory, 'data.json')
  })
}))
vi.mock('../browser/browser-client-host-id', () => ({ initializeBrowserClientHostId: vi.fn() }))
vi.mock('../host/deferred-secret-protection-report', () => ({
  scheduleSecretProtectionGapReport: vi.fn()
}))
vi.mock('../ssh/ssh-host-key-store', () => ({ initSshHostKeyStoreFile: vi.fn() }))
vi.mock('../pty/legacy-terminal-shim-dir', () => ({ neutralizeLegacyTerminalShimDir: vi.fn() }))
vi.mock('./windows-shell-path-hydration', () => ({
  createWindowsShellPathHydration: () => ({
    configure: vi.fn(),
    hydrate: vi.fn(async () => {}),
    whenReady: Promise.resolve()
  })
}))
vi.mock('../git/runner', () => ({
  configureWindowsHostGitEnvironmentReadiness: vi.fn(),
  setDefaultWslDistroOverride: vi.fn()
}))
vi.mock('../agent-hooks/wsl-hook-relay-manager', () => ({
  wslHookRelayManager: { setManagedHookSettingsResolver: vi.fn() }
}))
vi.mock('../app-icon', () => ({ applyAppIcon: vi.fn() }))
vi.mock('./dev-education-suppression', () => ({
  shouldSuppressDevEducation: () => false,
  suppressDevEducationForStore: vi.fn()
}))
vi.mock('../browser/browser-session-proxy', () => ({
  applyBrowserSessionProxies: vi.fn(async () => {}),
  setBrowserNetworkProxySettingsResolver: vi.fn(),
  invalidateBrowserSessionProxyApplication: vi.fn()
}))
vi.mock('../browser/doc-preview-protocol', () => ({ installDocPreviewProtocolHandler: vi.fn() }))
vi.mock('../media/media-preview-protocol', () => ({ installMediaPreviewProtocolHandler: vi.fn() }))
vi.mock('../ipc/doc-preview-grant-ipc', () => ({ registerDocPreviewGrantHandlers: vi.fn() }))

// browser-session-startup and browser-session-registry are deliberately NOT mocked: they are the
// one ready-phase path that can write the identity record, and stubbing them is what made the
// original assertion unable to fail. Only the pieces hanging off that path — partition policies,
// route sessions, cookie staging — are stubbed, so the meta load, the retired-choice inspection
// and the identity write are all real.
vi.mock('../browser/browser-route-session-runtime', () => ({
  configureRouteSessionsForOrcaProfile: vi.fn()
}))
vi.mock('../browser/paired-runtime-browser-client-host-runtime', () => ({
  configurePairedRuntimeBrowserClientHostsForOrcaProfile: vi.fn()
}))
vi.mock('../browser/browser-route-partition-storage-runtime', () => ({
  collectOrphanedBrowserRoutePartitionStorage: vi.fn(async () => {})
}))
vi.mock('../browser/browser-session-partition-policies', () => ({
  installBrowserSessionPartitionPolicies: vi.fn(async () => {}),
  forgetBrowserSessionPartitionConfiguration: vi.fn(),
  clearBrowserSessionPartitionPolicies: vi.fn()
}))
vi.mock('../browser/browser-session-cookie-staging', () => ({
  applyPendingBrowserCookieImports: vi.fn(),
  clearPendingBrowserCookieImport: vi.fn(),
  setPendingBrowserCookieImport: vi.fn()
}))
vi.mock('../browser/browser-session-route-policies', () => ({
  installBrowserRoutePartitionPolicies: vi.fn(),
  clearBrowserRoutePartitionPolicies: vi.fn()
}))
vi.mock('../browser/browser-session-profile-retirement', () => ({
  retireFailedBrowserSessionProfile: vi.fn(async () => {})
}))
vi.mock('../browser/browser-webauthn-account-picker', () => ({
  cancelBrowserWebAuthnAccountRequestsForSession: vi.fn()
}))

vi.mock('./startup-diagnostics', () => ({ logStartupMilestone: vi.fn() }))
vi.mock('./http1-compatibility-marker', () => ({ writeHttp1CompatibilityMarker: vi.fn() }))
vi.mock('../crash-reporting/durable-crash-breadcrumb', () => ({
  recordDurableCrashBreadcrumb: vi.fn()
}))
vi.mock('./main-window-actions', () => ({ syncMacMenuBarIcon: vi.fn() }))
vi.mock('./gpu-lifecycle', () => ({ updateGpuAccelerationAboutPanel: vi.fn() }))
vi.mock('../cli/wsl-cli-registration-reconciliation', () => ({
  logWslCliReconciliationResults: vi.fn(),
  reconcileManagedWslCliRegistrations: vi.fn(async () => [])
}))
vi.mock('./wsl-cli-reconciliation-startup-barrier', () => ({
  createWslCliReconciliationStartupBarrier: () => Promise.resolve()
}))
vi.mock('../agent-hooks/managed-agent-hook-controls', () => ({
  isAgentStatusHooksEnabled: vi.fn()
}))
vi.mock('./main-process-ready-runtime', () => ({
  initializeReadyRuntimeServices: vi.fn(async () => {})
}))
vi.mock('./main-process-i18n-menu', () => ({
  initializeMainProcessI18nAndMenu: vi.fn(async () => {})
}))
vi.mock('./main-process-runtime-launch', () => ({
  initializeMainProcessRuntimeLaunch: vi.fn(async (options: { openMainWindow: () => void }) => {
    if (mocks.state.isServeMode) {
      await mocks.runtimeRpcStart()
    } else {
      options.openMainWindow()
    }
  })
}))

import {
  BROWSER_IDENTITY_MODE_FILE,
  BROWSER_IDENTITY_MODE_VERSION,
  readBrowserIdentityModeRecord
} from '../browser/browser-identity-mode-record'
import { BROWSER_SESSION_META_FILE_NAME } from '../browser/browser-session-meta-store'
import { getOrcaProfileBrowserSessionPartition } from '../../shared/orca-profiles'

function seedIdentityRecord(mode: string, explicitSelection: boolean): void {
  writeFileSync(
    join(mocks.userDataPath, BROWSER_IDENTITY_MODE_FILE),
    JSON.stringify({
      version: BROWSER_IDENTITY_MODE_VERSION,
      mode,
      explicitSelection,
      migrationNoticePending: false
    }),
    'utf8'
  )
}

/** A profile carrying the retired per-profile choice, which is what arms the startup notice. */
function seedRetiredProfile(): void {
  writeFileSync(
    join(mocks.profileDirectory, BROWSER_SESSION_META_FILE_NAME),
    JSON.stringify({
      defaultSource: null,
      pendingCookieDbPath: null,
      pendingCookieImports: {},
      profiles: [
        {
          id: RETIRED_PROFILE_ID,
          scope: 'isolated',
          partition: getOrcaProfileBrowserSessionPartition(ORCA_PROFILE_ID, RETIRED_PROFILE_ID),
          label: 'Existing',
          source: null,
          userAgentMode: 'native'
        }
      ]
    }),
    'utf8'
  )
}

/**
 * `initializeBrowserSessionsForApp` latches on a module-level flag, so each case needs a fresh
 * module graph; that forces the dynamic imports here.
 */
async function runReady(): Promise<void> {
  const identity = await import('../browser/browser-identity-mode-store')
  // Preflight's read is what fixes the identity for this launch.
  identity.initializeBrowserIdentityModeStore(mocks.userDataPath)
  const { initializeMainProcessReady } = await import('./main-process-ready')
  await initializeMainProcessReady({
    openMainWindow: mocks.openMainWindow,
    handleMacAppActivation: vi.fn()
  })
  expect(mocks.handleProtocol).toHaveBeenCalledExactlyOnceWith(
    JIRA_IMAGE_SCHEME,
    expect.any(Function)
  )
}

function identityRecordWrites(): unknown[] {
  return mocks.writeFileDurableSync.mock.calls.filter(([, target]) =>
    String(target).endsWith(BROWSER_IDENTITY_MODE_FILE)
  )
}

describe('ready-phase browser identity authority', () => {
  beforeAll(() => {
    mocks.userDataPath = mkdtempSync(join(tmpdir(), 'orca-ready-identity-'))
    mocks.profileDirectory = mkdtempSync(join(tmpdir(), 'orca-ready-identity-profile-'))
  })

  beforeEach(() => {
    vi.resetModules()
    mocks.isPackaged = false
    mocks.setAppUserModelId.mockClear()
    mocks.openMainWindow.mockClear()
    mocks.handleProtocol.mockClear()
    mocks.runtimeRpcStart.mockClear()
    mocks.writeFileDurableSync.mockClear()
    mocks.state.isServeMode = false
  })

  afterEach(() => {
    Object.defineProperty(process, 'platform', { value: ORIGINAL_PLATFORM })
  })

  it.each([
    { platform: 'win32', isPackaged: true, appId: 'app.id' },
    { platform: 'win32', isPackaged: false, appId: process.execPath },
    { platform: 'darwin', isPackaged: true, appId: null },
    { platform: 'linux', isPackaged: true, appId: null }
  ])(
    'sets Windows app identity on $platform (packaged=$isPackaged)',
    async ({ platform, isPackaged, appId }) => {
      seedIdentityRecord('clean', true)
      mocks.isPackaged = isPackaged
      Object.defineProperty(process, 'platform', { value: platform })

      await runReady()

      if (appId === null) {
        expect(mocks.setAppUserModelId).not.toHaveBeenCalled()
      } else {
        expect(mocks.setAppUserModelId).toHaveBeenCalledExactlyOnceWith(appId)
      }
    }
  )

  // The bug: ready used to mirror a retired per-profile setting into the root record, so switching
  // from a native profile to a clean one started the clean profile in native. The root record read
  // before ready is the only authority now, and ready must not rewrite it in either direction —
  // not even when the real registry finds retired per-profile bytes sitting right beside it.
  it.each([{ rootMode: 'native' }, { rootMode: 'clean' }])(
    'leaves root=$rootMode authoritative over a retired profile choice',
    async ({ rootMode }) => {
      seedIdentityRecord(rootMode, true)
      seedRetiredProfile()

      await runReady()

      expect(readBrowserIdentityModeRecord(mocks.userDataPath)).toMatchObject({
        state: 'valid',
        appliedMode: rootMode,
        configuredMode: rootMode,
        explicitSelection: true,
        migrationNoticePending: false
      })
      // The explicit choice already retired the notice, so the real registry path must not
      // re-arm it — and with nothing to write, the record is never touched at all.
      expect(identityRecordWrites()).toEqual([])
    }
  )

  // The other half: proof the registry path this test stops mocking is actually live. Without an
  // explicit choice the same retired profile must arm the notice, through ready, on disk.
  it('arms the retired-choice notice through the real registry path', async () => {
    seedIdentityRecord('clean', false)
    seedRetiredProfile()

    await runReady()

    expect(identityRecordWrites()).toHaveLength(1)
    expect(readBrowserIdentityModeRecord(mocks.userDataPath)).toMatchObject({
      state: 'valid',
      appliedMode: 'clean',
      configuredMode: 'clean',
      explicitSelection: false,
      migrationNoticePending: true
    })
  })
})
