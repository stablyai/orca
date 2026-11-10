// Account-level Orca Cloud calls for the window: product config (measured timings) and GitHub connect.
import { ipcMain, shell } from 'electron'
import { ORCA_CLOUD_WORKSPACE_CHANNELS as CH } from '../../shared/hosted-sandbox/cloud-workspace-api'
import type { HostedSandboxConfigResponse } from '../../shared/hosted-sandbox/hosted-sandbox-wire'
import type { HostedSandboxControlPlaneClient } from './hosted-sandbox-control-plane-client'
import { failure } from './hosted-workspace-runtime'

export const HOSTED_ACCOUNT_CHANNELS = [CH.getConfig, CH.connectGitHub] as const

export function registerHostedAccountHandlers(
  client: Pick<HostedSandboxControlPlaneClient, 'config' | 'connectGitHub'>
): void {
  // Timings move slowly and the Worker caches them for 5 minutes; one read per app session is plenty.
  let config: Promise<HostedSandboxConfigResponse | null> | null = null
  ipcMain.handle(CH.getConfig, () => {
    config ??= client.config().catch(() => {
      // Offline now says nothing about later: ask again next time.
      config = null
      return null
    })
    return config
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
