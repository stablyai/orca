import { createBrowserTabInRenderer } from './browser-tab-renderer-create'
import type {
  BrowserDetectProfilesResult,
  BrowserProfileCreateResult,
  BrowserProfileDeleteResult,
  BrowserProfileListResult,
  BrowserTabProfileCloneResult,
  BrowserTabProfileShowResult,
  BrowserTabSetProfileResult,
  BrowserProfileClearDefaultCookiesResult,
  BrowserProfileImportFromBrowserResult
} from '../../../shared/runtime-types'
import { BrowserError } from '../../browser/browser-error'
import { browserSessionRegistry } from '../../browser/browser-session-registry'
import { browserManager } from '../../browser/browser-manager'
import { randomUUID } from 'node:crypto'
import { ipcMain } from 'electron'
import { waitForTabRegistration } from '../../ipc/browser-tab-registration-wait'
import {
  detectInstalledBrowsers,
  importCookiesFromBrowser,
  selectBrowserProfile
} from '../../browser/cookies/browser-cookie-import'
import type {
  BrowserCommandTargetParams,
  RuntimeBrowserCommandHost
} from './browser-command-contracts'
import type { RuntimeBrowserCommandTargets } from './browser-command-targets'
import type { RuntimeBrowserTabCatalog } from './browser-tab-catalog'
import type { RuntimeBrowserClientPlacement } from '../../../shared/runtime-browser-placement'

export class RuntimeBrowserProfiles {
  constructor(
    private readonly host: Pick<
      RuntimeBrowserCommandHost,
      | 'getAuthoritativeWindow'
      | 'getRuntimeBrowserPageRegistry'
      | 'getBrowserHostLeaseRegistry'
      | 'notifyHeadlessBrowserSessionTabsChanged'
    >,
    private readonly targets: Pick<
      RuntimeBrowserCommandTargets,
      'requireAgentBrowserBridge' | 'resolveBrowserCommandTarget'
    >,
    private readonly catalog: Pick<
      RuntimeBrowserTabCatalog,
      'describeBrowserTab' | 'resolveClientHostedBrowserPage'
    >
  ) {}

  async browserTabSetProfile(
    params: {
      profileId: string
    } & BrowserCommandTargetParams
  ): Promise<BrowserTabSetProfileResult> {
    const profile =
      browserSessionRegistry.getProfile(params.profileId) ??
      (params.profileId === 'default' ? browserSessionRegistry.getDefaultProfile() : null)
    if (!profile) {
      throw new BrowserError(
        'invalid_argument',
        `Browser profile ${params.profileId} was not found`
      )
    }

    // Resolve client pages first: server-local targets cannot resolve folder workspaces/remote guests.
    const clientPage = await this.catalog.resolveClientHostedBrowserPage(params)
    if (clientPage) {
      const { browserPageId } = clientPage
      if (clientPage.browserProfileId === profile.id) {
        return { browserPageId, profileId: profile.id, profileLabel: profile.label }
      }
      const authority = this.host.getBrowserHostLeaseRegistry()
      const publish = (placement: RuntimeBrowserClientPlacement): void => {
        this.host
          .getRuntimeBrowserPageRegistry()
          .replaceClientPagePlacement(
            browserPageId,
            clientPage.placement,
            placement,
            undefined,
            profile.id
          )
        this.host.notifyHeadlessBrowserSessionTabsChanged?.(clientPage.workspaceId)
      }
      const placement = await authority.switchClientPageProfile(
        {
          authorityRuntimeId: authority.authorityRuntimeId,
          authorityEpoch: authority.authorityEpoch,
          browserPageId,
          browserHostClientId: clientPage.placement.browserHostClientId,
          browserHostGeneration: clientPage.placement.browserHostGeneration,
          pageHostGeneration: clientPage.placement.pageHostGeneration
        },
        { id: profile.id, label: profile.label, scope: profile.scope },
        // Late success still changed the page after the caller timed out.
        publish
      )
      publish(placement)
      return { browserPageId, profileId: profile.id, profileLabel: profile.label }
    }

    const target = await this.targets.resolveBrowserCommandTarget(params)
    const browserPageId =
      target.browserPageId ??
      this.targets.requireAgentBrowserBridge().getActivePageId(target.worktreeId)
    if (!browserPageId) {
      throw new BrowserError('browser_no_tab', 'No browser tab open in this worktree')
    }

    // No-op switches must not tear down/remount the webview.
    const currentProfileId = browserManager.getSessionProfileIdForTab(browserPageId) ?? 'default'
    if (currentProfileId === profile.id) {
      return {
        browserPageId,
        profileId: profile.id,
        profileLabel: profile.label
      }
    }

    const win = this.host.getAuthoritativeWindow()
    const requestId = randomUUID()
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        ipcMain.removeListener('browser:tabSetProfileReply', handler)
        reject(new Error('Tab profile update timed out'))
      }, 10_000)

      const handler = (
        _event: Electron.IpcMainEvent,
        reply: { requestId: string; error?: string }
      ): void => {
        if (reply.requestId !== requestId) {
          return
        }
        clearTimeout(timer)
        ipcMain.removeListener('browser:tabSetProfileReply', handler)
        if (reply.error) {
          reject(new Error(reply.error))
        } else {
          resolve()
        }
      }
      ipcMain.on('browser:tabSetProfileReply', handler)
      win.webContents.send('browser:requestTabSetProfile', {
        requestId,
        browserPageId,
        profileId: profile.id,
        sessionPartition: profile.partition
      })
    })

    // Profile changes remount the guest; wait until follow-up commands can use it.
    try {
      await waitForTabRegistration(browserPageId)
    } catch {
      // Hidden worktrees may register only on their next mount.
    }

    return {
      browserPageId,
      profileId: profile.id,
      profileLabel: profile.label
    }
  }

  async browserTabProfileShow(params: {
    page: string
    worktree?: string
  }): Promise<BrowserTabProfileShowResult> {
    const target = await this.targets.resolveBrowserCommandTarget(params)
    const tab = this.catalog.describeBrowserTab(params.page, target.worktreeId)
    return {
      browserPageId: tab.browserPageId,
      worktreeId: tab.worktreeId ?? null,
      profileId: tab.profileId ?? null,
      profileLabel: tab.profileLabel ?? null
    }
  }

  async browserTabProfileClone(
    params: {
      profileId: string
    } & BrowserCommandTargetParams
  ): Promise<BrowserTabProfileCloneResult> {
    const target = await this.targets.resolveBrowserCommandTarget(params)
    const sourceBrowserPageId =
      target.browserPageId ??
      this.targets.requireAgentBrowserBridge().getActivePageId(target.worktreeId)
    if (!sourceBrowserPageId) {
      throw new BrowserError('browser_no_tab', 'No browser tab open in this worktree')
    }
    const sourceTab = this.catalog.describeBrowserTab(sourceBrowserPageId, target.worktreeId)
    const profile = browserSessionRegistry.getProfile(params.profileId)
    if (!profile) {
      throw new BrowserError(
        'invalid_argument',
        `Browser profile ${params.profileId} was not found`
      )
    }
    const created = await createBrowserTabInRenderer(
      this.host,
      sourceTab.url,
      sourceTab.worktreeId ?? target.worktreeId,
      profile.id,
      profile.partition
    )
    // Do not return an inoperable clone before its webview registers.
    try {
      await waitForTabRegistration(created.browserPageId)
    } catch {}
    return {
      browserPageId: created.browserPageId,
      sourceBrowserPageId,
      profileId: profile.id,
      profileLabel: profile.label
    }
  }

  async browserProfileList(): Promise<BrowserProfileListResult> {
    return { profiles: browserSessionRegistry.listProfiles() }
  }

  async browserProfileCreate(params: {
    label: string
    scope: 'isolated' | 'imported'
  }): Promise<BrowserProfileCreateResult> {
    return {
      profile: await browserSessionRegistry.createProfile(params.scope, params.label)
    }
  }

  async browserProfileDelete(params: { profileId: string }): Promise<BrowserProfileDeleteResult> {
    return {
      deleted: await browserSessionRegistry.deleteProfile(params.profileId),
      profileId: params.profileId
    }
  }

  async browserProfileDetectBrowsers(): Promise<BrowserDetectProfilesResult> {
    return {
      // Expose display metadata only; retain paths/keychain identifiers on the server.
      browsers: detectInstalledBrowsers().map((browser) => ({
        family: browser.family,
        label: browser.label,
        profiles: browser.profiles,
        selectedProfile: browser.selectedProfile
      }))
    }
  }

  async browserProfileImportFromBrowser(params: {
    profileId: string
    browserFamily: string
    browserProfile?: string
    supportsPartitionSkippedCookies?: true
  }): Promise<BrowserProfileImportFromBrowserResult> {
    const profile = browserSessionRegistry.getProfile(params.profileId)
    if (!profile) {
      return { ok: false, reason: 'Session profile not found.' }
    }
    if (
      params.browserProfile &&
      (/[/\\]/.test(params.browserProfile) || params.browserProfile.includes('..'))
    ) {
      return { ok: false, reason: 'Invalid browser profile name.' }
    }

    const browsers = detectInstalledBrowsers()
    let browser = browsers.find((candidate) => candidate.family === params.browserFamily)
    if (!browser) {
      return { ok: false, reason: 'Browser not found on this system.' }
    }

    if (params.browserProfile && params.browserProfile !== browser.selectedProfile) {
      const reselected = selectBrowserProfile(browser, params.browserProfile)
      if (!reselected) {
        return {
          ok: false,
          reason: `No cookies database found for profile "${params.browserProfile}".`
        }
      }
      browser = reselected
    }

    const result = await importCookiesFromBrowser(browser, profile.partition, {
      canReportPartitionSkippedCookies: params.supportsPartitionSkippedCookies === true
    })
    if (!result.ok) {
      return result
    }

    const profileName =
      browser.profiles.find((candidate) => candidate.directory === browser.selectedProfile)?.name ??
      browser.selectedProfile
    browserSessionRegistry.updateProfileSource(params.profileId, {
      browserFamily: browser.family,
      profileName,
      importedAt: Date.now()
    })
    return { ...result, profileId: params.profileId }
  }

  async browserProfileClearDefaultCookies(): Promise<BrowserProfileClearDefaultCookiesResult> {
    return { cleared: await browserSessionRegistry.clearDefaultSessionCookies() }
  }
}
