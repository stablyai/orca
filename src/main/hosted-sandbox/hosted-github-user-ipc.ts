// The person's own GitHub identity for Orca Cloud: with it connected, commits and pushes in cloud
// workspaces carry their name; without it they use Orca Cloud's. Distinct from the GitHub App
// install (hosted-account-ipc), which is account-wide repository access.
import { ipcMain, shell } from 'electron'
import { ORCA_CLOUD_WORKSPACE_CHANNELS as CH } from '../../shared/hosted-sandbox/cloud-workspace-api'
import type { HostedSandboxControlPlaneClient } from './hosted-sandbox-control-plane-client'
import { failure } from './hosted-workspace-runtime'

export const HOSTED_GITHUB_USER_CHANNELS = [
  CH.getGitHubUser,
  CH.connectGitHubUser,
  CH.disconnectGitHubUser
] as const

export function registerHostedGitHubUserHandlers(
  client: Pick<
    HostedSandboxControlPlaneClient,
    'githubUser' | 'connectGitHubUser' | 'disconnectGitHubUser'
  >
): void {
  ipcMain.handle(CH.getGitHubUser, async () => {
    try {
      return { ok: true, value: await client.githubUser() }
    } catch (error) {
      return failure(error)
    }
  })

  ipcMain.handle(CH.connectGitHubUser, async () => {
    try {
      const { authorizeUrl } = await client.connectGitHubUser()
      // Only ever hand the browser a GitHub page, whatever the response says.
      if (new URL(authorizeUrl).origin !== 'https://github.com') {
        return { ok: false, code: 'failed', message: 'Unexpected GitHub connect URL.' }
      }
      await shell.openExternal(authorizeUrl)
      return { ok: true, value: null }
    } catch (error) {
      return failure(error)
    }
  })

  ipcMain.handle(CH.disconnectGitHubUser, async () => {
    try {
      return { ok: true, value: await client.disconnectGitHubUser() }
    } catch (error) {
      return failure(error)
    }
  })
}
