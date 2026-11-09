import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const {
  sessionFromPartitionMock,
  askForMediaAccessMock,
  getMediaAccessStatusMock,
  removeCertificateRequestGuardMock
} = vi.hoisted(() => ({
  sessionFromPartitionMock: vi.fn(),
  askForMediaAccessMock: vi.fn(),
  getMediaAccessStatusMock: vi.fn(),
  removeCertificateRequestGuardMock: vi.fn()
}))
const forgetBrowserPasswordVaultMock = vi.hoisted(() => vi.fn(() => true))
const processUserAgentMode = vi.hoisted(() => {
  const state: { value: 'clean' | 'native' } = { value: 'clean' }
  return state
})

vi.mock('electron', () => ({
  session: {
    fromPartition: sessionFromPartitionMock
  },
  systemPreferences: {
    askForMediaAccess: askForMediaAccessMock,
    getMediaAccessStatus: getMediaAccessStatusMock
  }
}))

// Extension loading and cleanup have their own tests (browser-extension-session-loader.test.ts).
vi.mock('../../extensions/profile-sessions/browser-extension-session-loader', () => ({
  attachBrowserExtensionsToProfileSession: () => {},
  detachBrowserExtensionsFromProfileSession: async () => {}
}))

vi.mock('../../identity/browser-process-user-agent', () => ({
  getBrowserProcessUserAgentIdentity: () => ({
    mode: processUserAgentMode.value,
    userAgent: 'Mozilla/5.0 Chrome/150.0.0.0 Safari/537.36',
    electronUserAgent: 'Mozilla/5.0 Orca/1.0.0 Chrome/150.0.0.0 Electron/43.0.0 Safari/537.36'
  })
}))

vi.mock('../../guest-lifecycle/manager/browser-manager', () => ({
  browserManager: {
    notifyPermissionDenied: vi.fn(),
    handleGuestWillDownload: vi.fn(),
    installCertificateRequestGuard: vi.fn(),
    removeCertificateRequestGuard: removeCertificateRequestGuardMock,
    resolvePagePromptTarget: vi.fn(() => null)
  }
}))

vi.mock('../../../browser-passwords/browser-password-vaults', () => ({
  forgetBrowserPasswordVault: forgetBrowserPasswordVaultMock
}))

import { browserSessionRegistry } from './browser-session-registry'
import { isValidPersistedBrowserSessionProfile } from './browser-session-persisted-profile-validation'
import {
  deleteManagedBrowserProfile,
  ensureManagedBrowserProfile
} from './browser-managed-session-profiles'
import {
  configureBrowserSitePermissionStore,
  listBrowserSitePermissions,
  setBrowserSitePermissionDecisions
} from '../../site-settings/permissions/browser-site-permission-store'
import { setBrowserNetworkProxySettingsResolver } from '../proxy/browser-session-proxy'
import { handleElectronProxyLogin } from '../../../network/electron-proxy-credentials'
import { applyProxySettingsToSession } from '../../../network/proxy-settings'
import { DEFAULT_LOCAL_ORCA_PROFILE_ID } from '../../../../shared/orca-profiles'

describe('BrowserSessionRegistry', () => {
  let profileDirectory: string

  afterEach(() => {
    rmSync(profileDirectory, { recursive: true, force: true })
  })

  beforeEach(() => {
    profileDirectory = mkdtempSync(join(tmpdir(), 'orca-session-registry-'))
    browserSessionRegistry.configureForOrcaProfile({
      orcaProfileId: DEFAULT_LOCAL_ORCA_PROFILE_ID,
      profileDirectory
    })
    sessionFromPartitionMock.mockReset()
    askForMediaAccessMock.mockReset()
    getMediaAccessStatusMock.mockReset()
    removeCertificateRequestGuardMock.mockClear()
    processUserAgentMode.value = 'clean'
    setBrowserNetworkProxySettingsResolver(null)
    askForMediaAccessMock.mockResolvedValue(true)
    getMediaAccessStatusMock.mockReturnValue('granted')
    sessionFromPartitionMock.mockReturnValue({
      setUserAgent: vi.fn(),
      webRequest: { onBeforeSendHeaders: vi.fn() },
      setPermissionRequestHandler: vi.fn(),
      setPermissionCheckHandler: vi.fn(),
      setDevicePermissionHandler: vi.fn(),
      setDisplayMediaRequestHandler: vi.fn(),
      on: vi.fn(),
      removeListener: vi.fn(),
      resolveProxy: vi.fn().mockResolvedValue('DIRECT'),
      setProxy: vi.fn().mockResolvedValue(undefined),
      closeAllConnections: vi.fn().mockResolvedValue(undefined),
      clearStorageData: vi.fn().mockResolvedValue(undefined),
      clearCache: vi.fn().mockResolvedValue(undefined)
    })
  })

  it('does not return a runtime profile until its proxy is ready', async () => {
    let finishWrite: (() => void) | undefined
    let proxyReady = false
    const navigate = vi.fn((_partition: string | undefined) => expect(proxyReady).toBe(true))
    const proxySession = sessionFromPartitionMock()
    proxySession.setProxy.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          finishWrite = () => {
            proxyReady = true
            resolve()
          }
        })
    )
    sessionFromPartitionMock.mockReturnValueOnce(proxySession)
    setBrowserNetworkProxySettingsResolver(() => ({
      httpProxyUrl: 'socks5://127.0.0.1:1080',
      httpProxyBypassRules: ''
    }))

    let ready = false
    const creation = browserSessionRegistry
      .createProfile('isolated', 'Proxy Ready')
      .then((profile) => {
        ready = true
        navigate(profile?.partition)
        return profile
      })
    await vi.waitFor(() => expect(proxySession.setProxy).toHaveBeenCalledTimes(1))
    expect(ready).toBe(false)
    expect(navigate).not.toHaveBeenCalled()

    finishWrite?.()
    await expect(creation).resolves.not.toBeNull()
    expect(ready).toBe(true)
    expect(navigate).toHaveBeenCalledTimes(1)
  })

  it('rejects and rolls back a runtime profile when its proxy cannot be applied', async () => {
    const before = browserSessionRegistry.listProfiles().length
    const proxySession = sessionFromPartitionMock()
    proxySession.setProxy.mockRejectedValue(new Error('proxy unavailable'))
    sessionFromPartitionMock.mockReturnValue(proxySession)
    setBrowserNetworkProxySettingsResolver(() => ({
      httpProxyUrl: 'socks5://127.0.0.1:1080',
      httpProxyBypassRules: ''
    }))

    await expect(browserSessionRegistry.createProfile('isolated', 'Proxy Failure')).rejects.toThrow(
      'proxy unavailable'
    )

    expect(browserSessionRegistry.listProfiles()).toHaveLength(before)
    expect(proxySession.setPermissionRequestHandler).toHaveBeenLastCalledWith(null)
    expect(proxySession.setPermissionCheckHandler).toHaveBeenLastCalledWith(null)
  })

  it('retires credentials when profile creation and proxy rollback both fail', async () => {
    const proxySession = sessionFromPartitionMock()
    proxySession.setProxy
      .mockResolvedValueOnce(undefined)
      .mockRejectedValue(new Error('proxy rollback failed'))
    proxySession.closeAllConnections.mockRejectedValueOnce(new Error('proxy settlement failed'))
    proxySession.setPermissionRequestHandler.mockImplementation((handler: unknown) => {
      if (handler === null) {
        throw new Error('policy cleanup failed')
      }
    })
    sessionFromPartitionMock.mockReturnValue(proxySession)
    setBrowserNetworkProxySettingsResolver(() => ({
      httpProxyUrl: 'http://alice:secret@proxy.example:8080',
      httpProxyBypassRules: ''
    }))

    await expect(
      browserSessionRegistry.createProfile('isolated', 'Proxy Rollback')
    ).rejects.toThrow('proxy rollback failed')
    const callback = vi.fn()
    handleElectronProxyLogin(
      { preventDefault: vi.fn() } as never,
      { session: proxySession } as never,
      {} as never,
      { isProxy: true, host: 'proxy.example', port: 8080 },
      callback
    )

    expect(callback).not.toHaveBeenCalled()
    await expect(
      applyProxySettingsToSession(
        proxySession,
        { httpProxyUrl: 'http://later.example:8080' },
        { env: {} }
      )
    ).rejects.toThrow('retired')
  })

  it('deletes a non-default profile and its remembered site answers', async () => {
    configureBrowserSitePermissionStore(mkdtempSync(join(tmpdir(), 'orca-site-permissions-')))
    const profile = await browserSessionRegistry.createProfile('isolated', 'Delete Test')
    expect(profile).not.toBeNull()
    expect(browserSessionRegistry.isAllowedPartition(profile!.partition)).toBe(true)
    setBrowserSitePermissionDecisions(profile!.id, 'https://example.com', ['camera'], 'allow')
    const deleted = await browserSessionRegistry.deleteProfile(profile!.id)
    expect(deleted).toBe(true)
    expect(browserSessionRegistry.isAllowedPartition(profile!.partition)).toBe(false)
    expect(browserSessionRegistry.getProfile(profile!.id)).toBeNull()
    expect(listBrowserSitePermissions(profile!.id)).toEqual([])
  })

  // Electron Sessions outlive deleted profiles; their header hooks must be retired.

  it('creates one managed profile per owner and a fresh one after its owner is removed', async () => {
    const owner = { kind: 'worktree' as const, id: 'repo-1::/work/feature' }
    const [first, concurrent] = await Promise.all([
      ensureManagedBrowserProfile(owner, 'Workspace: feature'),
      ensureManagedBrowserProfile(owner, 'Workspace: feature')
    ])
    const repoProfile = await ensureManagedBrowserProfile({ kind: 'repo', id: 'repo-1' }, 'Repo')
    if (!first || !repoProfile) {
      throw new Error('Expected managed profiles')
    }

    expect(concurrent).toBe(first)
    expect(repoProfile.partition).not.toBe(first.partition)
    expect(isValidPersistedBrowserSessionProfile(first, DEFAULT_LOCAL_ORCA_PROFILE_ID)).toBe(true)

    expect(await deleteManagedBrowserProfile(owner)).toBe(true)
    expect(browserSessionRegistry.isAllowedPartition(first.partition)).toBe(false)
    expect(browserSessionRegistry.getProfile(repoProfile.id)).not.toBeNull()
    // A workspace recreated at the same path must not land on the deleted, retired session.
    const recreated = await ensureManagedBrowserProfile(owner, 'Workspace: feature')
    expect(recreated?.partition).not.toBe(first.partition)
  })

  it('announces each profile change after the list reflects it', async () => {
    const seen: string[][] = []
    browserSessionRegistry.onProfilesChanged = () =>
      seen.push(browserSessionRegistry.listProfiles().map((profile) => profile.label))
    try {
      const made = await browserSessionRegistry.createProfile('isolated', 'Made by CLI')
      const managed = await ensureManagedBrowserProfile({ kind: 'repo', id: 'announce' }, 'Repo')
      if (!made || !managed) {
        throw new Error('Expected created profiles')
      }
      browserSessionRegistry.updateProfileSource(made.id, {
        browserFamily: 'manual',
        importedAt: 1
      })
      await browserSessionRegistry.deleteProfile(made.id)
      await browserSessionRegistry.deleteProfile('default')
      await browserSessionRegistry.createProfile('default', 'Refused')

      expect(seen).toHaveLength(4)
      expect(seen[0]).toContain('Made by CLI')
      expect(seen[1]).toContain('Repo')
      expect(seen[2]).toContain('Made by CLI')
      expect(seen[3]).not.toContain('Made by CLI')
    } finally {
      browserSessionRegistry.onProfilesChanged = null
    }
  })
})
