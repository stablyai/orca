import { clearGoogleCookiesForRuntimeProfile } from '../../../browser/cookies/browser-google-cookie-clear'
import { browserCookieImportFailure } from '../../../../shared/browser/cookies/browser-cookie-import-failure-copy'
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
} from '../../../../shared/browser/runtime/runtime-browser-contracts'
import { BrowserError } from '../../../browser/browser-error'
import { browserSessionRegistry } from '../../../browser/sessions/profiles/browser-session-registry'
import { browserManager } from '../../../browser/guest-lifecycle/manager/browser-manager'
import { getRuntimeDesktopSurface } from '../../construction/runtime-desktop-surface'
import { waitForTabRegistration } from '../../../ipc/browser/browser-tab-registration-wait'
import {
  detectInstalledBrowsers,
  resolveBrowserImportSelection,
  selectBrowserProfile
} from '../../../browser/cookies/sources/browser-cookie-detection'
import { importedBrowserProfileSource } from '../../../browser/cookies/sources/browser-cookie-source-profiles'
import type { BrowserCookieImportSelection } from '../../../../shared/browser/workspaces/browser-workspace-types'
import { importCookiesFromBrowser } from '../../../browser/cookies/browser-cookie-import'
import type {
  BrowserCommandTargetParams,
  RuntimeBrowserCommandHost
} from './browser-command-contracts'
import type { RuntimeBrowserCommandTargets } from './browser-command-targets'
import type { RuntimeBrowserTabCatalog } from '../tabs/browser-tab-catalog'
import type { RuntimeBrowserTabCreation } from '../tabs/browser-tab-creation'
import type { BrowserClientPageOpeningHost } from '../client-pages/browser-client-page-opening'
import { cloneBrowserTabToProfile } from './browser-tab-profile-clone'
import type { RuntimeBrowserClientPlacement } from '../../../../shared/browser/client-hosting/runtime-browser-placement'

export class RuntimeBrowserProfiles {
  constructor(
    private readonly host: Pick<
      RuntimeBrowserCommandHost,
      'getRuntimeId' | 'getAuthoritativeWindowId' | 'getAvailableAuthoritativeWindowId'
    > &
      BrowserClientPageOpeningHost,
    private readonly targets: Pick<
      RuntimeBrowserCommandTargets,
      'requireAgentBrowserBridge' | 'resolveBrowserCommandTarget'
    >,
    private readonly catalog: Pick<
      RuntimeBrowserTabCatalog,
      'describeBrowserTab' | 'describeClientHostedBrowserTab' | 'resolveClientHostedBrowserPage'
    >,
    private readonly creation: Pick<RuntimeBrowserTabCreation, 'browserTabCreate'>
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

    const windowId = this.host.getAuthoritativeWindowId()
    const reply = await getRuntimeDesktopSurface().requestRenderer<{
      requestId: string
      error?: string
    }>(windowId, {
      channel: 'browser:requestTabSetProfile',
      replyChannel: 'browser:tabSetProfileReply',
      payload: {
        browserPageId,
        profileId: profile.id,
        sessionPartition: profile.partition
      },
      timeoutMs: 10_000,
      timeoutMessage: 'Tab profile update timed out'
    })
    if (reply.error) {
      throw new Error(reply.error)
    }

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
    // Client pages live in this runtime's page registry, not in its own browser's tab list.
    const clientPage = await this.catalog.resolveClientHostedBrowserPage(params)
    const tab = clientPage
      ? this.catalog.describeClientHostedBrowserTab(clientPage)
      : this.catalog.describeBrowserTab(
          params.page,
          (await this.targets.resolveBrowserCommandTarget(params)).worktreeId
        )
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
    return cloneBrowserTabToProfile(
      { host: this.host, targets: this.targets, catalog: this.catalog, creation: this.creation },
      params
    )
  }

  async browserProfileList(): Promise<BrowserProfileListResult> {
    return {
      profiles: browserSessionRegistry.listProfiles(),
      executorRuntimeId: this.host.getRuntimeId()
    }
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

  async browserProfileImportFromBrowser(
    params: {
      profileId: string
      supportsPartitionSkippedCookies?: true
    } & BrowserCookieImportSelection
  ): Promise<BrowserProfileImportFromBrowserResult> {
    const profile = browserSessionRegistry.getProfile(params.profileId)
    if (!profile) {
      return browserCookieImportFailure('profileNotFound')
    }
    const selection = resolveBrowserImportSelection(params, profile.source)
    if ('reason' in selection) {
      return selection
    }
    const [detected] = detectInstalledBrowsers(selection.browserFamily)
    const browser = selectBrowserProfile(detected, selection)
    if ('reason' in browser) {
      return browser
    }

    const result = await importCookiesFromBrowser(browser, profile.partition, {
      canReportPartitionSkippedCookies: params.supportsPartitionSkippedCookies === true
    })
    if (!result.ok) {
      return result
    }

    browserSessionRegistry.updateProfileSource(
      params.profileId,
      importedBrowserProfileSource(browser)
    )
    return { ...result, profileId: params.profileId, executorRuntimeId: this.host.getRuntimeId() }
  }

  async browserProfileClearGoogleCookies(params: { profileId: string; executorRuntimeId: string }) {
    return clearGoogleCookiesForRuntimeProfile(params, this.host.getRuntimeId())
  }

  async browserProfileClearDefaultCookies(): Promise<BrowserProfileClearDefaultCookiesResult> {
    return { cleared: await browserSessionRegistry.clearDefaultSessionCookies() }
  }
}
