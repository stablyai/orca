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
  CH.gitHubUserConnectLink,
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

  // Only ever hand out a GitHub page, whatever the response says.
  const mintAuthorizeUrl = async (): Promise<string> => {
    const { authorizeUrl } = await client.connectGitHubUser()
    if (new URL(authorizeUrl).origin !== 'https://github.com') {
      throw new Error('Unexpected GitHub connect URL.')
    }
    return authorizeUrl
  }

  ipcMain.handle(CH.connectGitHubUser, async () => {
    try {
      await shell.openExternal(await mintAuthorizeUrl())
      return { ok: true, value: null }
    } catch (error) {
      return failure(error)
    }
  })

  // "Copy link": the same OAuth page, for another browser or profile; nothing opens here.
  ipcMain.handle(CH.gitHubUserConnectLink, async () => {
    try {
      return { ok: true, value: await mintAuthorizeUrl() }
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
