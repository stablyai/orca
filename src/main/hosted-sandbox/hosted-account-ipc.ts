// Account-level Orca Cloud calls for the window: product config (measured timings) and GitHub connect.
import { ipcMain, shell } from 'electron'
import { ORCA_CLOUD_WORKSPACE_CHANNELS as CH } from '../../shared/hosted-sandbox/cloud-workspace-api'
import type { HostedSandboxConfigResponse } from '../../shared/hosted-sandbox/hosted-sandbox-wire'
import type { HostedSandboxControlPlaneClient } from './hosted-sandbox-control-plane-client'
import { failure } from './hosted-workspace-runtime'

const CONFIG_TTL_MS = 5 * 60_000

export const HOSTED_ACCOUNT_CHANNELS = [CH.getConfig, CH.connectGitHub] as const

export function registerHostedAccountHandlers(
  client: Pick<HostedSandboxControlPlaneClient, 'config' | 'connectGitHub'>
): void {
  // The Worker re-measures every 5 minutes; match it so each new build sheet sees a fresh median.
  let config: { at: number; value: Promise<HostedSandboxConfigResponse | null> } | null = null
  ipcMain.handle(CH.getConfig, () => {
    const now = Date.now()
    if (!config || now - config.at >= CONFIG_TTL_MS) {
      const entry = {
        at: now,
        value: client.config().catch(() => {
          // Offline now says nothing about later: ask again next time.
          if (config === entry) {
            config = null
          }
          return null
        })
      }
      config = entry
    }
    return config.value
  })

  ipcMain.handle(CH.connectGitHub, async () => {
    try {
      const { installUrl } = await client.connectGitHub()
      // Only ever hand the browser a GitHub page, whatever the response says.
      if (new URL(installUrl).origin !== 'https://github.com') {
        return { ok: false, code: 'failed', message: 'Unexpected GitHub connect URL.' }
      }
      await shell.openExternal(installUrl)
      return { ok: true, value: null }
    } catch (error) {
      return failure(error)
    }
  })
}
