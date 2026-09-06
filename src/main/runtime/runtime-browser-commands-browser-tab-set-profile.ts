// @ts-nocheck -- mechanically split class members.
import { RuntimeBrowserCommandsWithBrowserTabCreate } from './runtime-browser-commands-browser-tab-create'
import type { BrowserCommandTargetParams } from './runtime-browser-commands-browser-command-target-params'
import type {
  BrowserDetectProfilesResult,
  BrowserProfileCreateResult,
  BrowserProfileDeleteResult,
  BrowserProfileListResult,
  BrowserTabProfileCloneResult,
  BrowserTabProfileShowResult,
  BrowserTabSetProfileResult
} from '../../shared/runtime-types'
import { BrowserError } from '../browser/browser-error'
import { browserSessionRegistry } from '../browser/browser-session-registry'
import { browserManager } from '../browser/browser-manager'
import { randomUUID } from 'node:crypto'
import { ipcMain } from 'electron'
import { waitForTabRegistration } from '../ipc/browser-tab-registration-wait'
import type { BrowserSessionUserAgentMode } from '../../shared/browser-workspace-types'
import { detectInstalledBrowsers } from '../browser/browser-cookie-import'

export class RuntimeBrowserCommandsWithBrowserTabSetProfile extends RuntimeBrowserCommandsWithBrowserTabCreate {
  async browserTabSetProfile(
    params: {
      profileId: string
    } & BrowserCommandTargetParams
  ): Promise<BrowserTabSetProfileResult> {
    const target = await this.resolveBrowserCommandTarget(params)
    const browserPageId =
      target.browserPageId ?? this.requireAgentBrowserBridge().getActivePageId(target.worktreeId)
    if (!browserPageId) {
      throw new BrowserError('browser_no_tab', 'No browser tab open in this worktree')
    }
    // Why: 'default' is a synthetic id; fall back to the registry's default profile when not registered.
    const profile =
      browserSessionRegistry.getProfile(params.profileId) ??
      (params.profileId === 'default' ? browserSessionRegistry.getDefaultProfile() : null)
    if (!profile) {
      throw new BrowserError(
        'invalid_argument',
        `Browser profile ${params.profileId} was not found`
      )
    }

    // Why: short-circuit no-op switches so the renderer doesn't needlessly tear down and remount the webview.
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

    // Why: profile change remounts the webview; wait for re-register so follow-up commands see the new profile and an attached guest.
    try {
      await waitForTabRegistration(browserPageId)
    } catch {
      // Best-effort: re-register won't fire while the worktree is hidden; downstream commands retry once the pane re-mounts.
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
    const target = await this.resolveBrowserCommandTarget(params)
    const tab = this.describeBrowserTab(params.page, target.worktreeId)
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
    const target = await this.resolveBrowserCommandTarget(params)
    const sourceBrowserPageId =
      target.browserPageId ?? this.requireAgentBrowserBridge().getActivePageId(target.worktreeId)
    if (!sourceBrowserPageId) {
      throw new BrowserError('browser_no_tab', 'No browser tab open in this worktree')
    }
    const sourceTab = this.describeBrowserTab(sourceBrowserPageId, target.worktreeId)
    const profile = browserSessionRegistry.getProfile(params.profileId)
    if (!profile) {
      throw new BrowserError(
        'invalid_argument',
        `Browser profile ${params.profileId} was not found`
      )
    }
    const created = await this.createBrowserTabInRenderer(
      sourceTab.url,
      sourceTab.worktreeId ?? target.worktreeId,
      profile.id,
      profile.partition
    )
    // Why: wait for the cloned tab's webview to register so the returned browserPageId is operable by the next CLI call.
    try {
      await waitForTabRegistration(created.browserPageId)
    } catch {
      // Best-effort: registration may not fire if the worktree is hidden.
    }
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
    userAgentMode?: BrowserSessionUserAgentMode
  }): Promise<BrowserProfileCreateResult> {
    return {
      profile: await browserSessionRegistry.createProfile(params.scope, params.label, {
        userAgentMode: params.userAgentMode
      })
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
      // Why: expose only display metadata; filesystem paths and keychain identifiers stay on the runtime server.
      browsers: detectInstalledBrowsers().map((browser) => ({
        family: browser.family,
        label: browser.label,
        profiles: browser.profiles,
        selectedProfile: browser.selectedProfile
      }))
    }
  }
}
