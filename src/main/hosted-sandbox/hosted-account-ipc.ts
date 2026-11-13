// Account-level Orca Cloud calls for the window: product config (measured timings), GitHub connect,
// repository access (cloud-start N2) and the repositories the account's GitHub installations reach.
import { ipcMain, shell } from 'electron'
import { ORCA_CLOUD_WORKSPACE_CHANNELS as CH } from '../../shared/hosted-sandbox/cloud-workspace-api'
import type { HostedSandboxConfigResponse } from '../../shared/hosted-sandbox/hosted-sandbox-wire'
import type { HostedSandboxControlPlaneClient } from './hosted-sandbox-control-plane-client'
import { failure } from './hosted-workspace-runtime'
import { githubRepoSlug, lookupGitHubRepoIds, type GitHubRepoIds } from './github-repo-ids'
import {
  CLOUD_CREATE_IDEMPOTENCY_KEY,
  CLOUD_CREATE_PROVISION_ID,
  createCloudWorkspaceFromGitHub
} from './cloud-create-from-github'
import { activeProvisionControllers } from '../ipc/provision-controllers'
import {
  HOSTED_GITHUB_USER_CHANNELS,
  registerHostedGitHubUserHandlers
} from './hosted-github-user-ipc'

const CONFIG_TTL_MS = 5 * 60_000
const SETUP_SESSION_ID = /^cs_[A-Za-z0-9_-]{22}$/

export const HOSTED_ACCOUNT_CHANNELS = [
  CH.getConfig,
  CH.connectGitHub,
  CH.getRepoAccess,
  CH.listGitHubRepositories,
  CH.createFromGitHub,
  ...HOSTED_GITHUB_USER_CHANNELS
] as const

type RepoArgs = { repoUrl?: unknown; setupSessionId?: unknown } | undefined

/** A https://github.com/<owner>/<repo> URL and a well-formed setup session id, or nothing. */
function repoTarget(args: RepoArgs): { repo: string; setupSessionId?: string } | null {
  const slug = typeof args?.repoUrl === 'string' ? githubRepoSlug(args.repoUrl) : null
  if (!slug) {
    return null
  }
  const session =
    typeof args?.setupSessionId === 'string' && SETUP_SESSION_ID.test(args.setupSessionId)
      ? args.setupSessionId
      : undefined
  return { repo: `https://github.com/${slug}`, ...(session ? { setupSessionId: session } : {}) }
}

export function registerHostedAccountHandlers(
  client: Pick<
    HostedSandboxControlPlaneClient,
    | 'config'
    | 'connectGitHub'
    | 'githubRepoAccess'
    | 'githubRepositories'
    | 'create'
    | 'bootPlan'
    | 'cloneStatus'
    | 'destroy'
    | 'githubUser'
    | 'connectGitHubUser'
    | 'disconnectGitHubUser'
  >,
  options: { repoIds?: (repoUrl: string) => Promise<GitHubRepoIds | null> } = {}
): void {
  const repoIds = options.repoIds ?? lookupGitHubRepoIds
  registerHostedGitHubUserHandlers(client)
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

  ipcMain.handle(CH.connectGitHub, async (_event, args?: RepoArgs) => {
    try {
      const target = repoTarget(args)
      const ids = target ? await repoIds(target.repo) : null
      const { installUrl } = await client.connectGitHub(
        undefined,
        target ? { ...target, ...ids } : undefined
      )
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

  ipcMain.handle(CH.getRepoAccess, async (_event, args?: RepoArgs) => {
    const target = repoTarget(args)
    if (!target) {
      return { ok: false, code: 'failed', message: 'Not a GitHub repository.' }
    }
    try {
      const answer = await client.githubRepoAccess(target)
      if (answer.access !== 'missing') {
        return { ok: true, value: answer }
      }
      // Missing: ask again with the ids GitHub's install page needs to preselect only this repo.
      const ids = await repoIds(target.repo)
      const value = ids ? await client.githubRepoAccess({ ...target, ...ids }) : answer
      if (value.installUrl && new URL(value.installUrl).origin !== 'https://github.com') {
        return { ok: true, value: { ...value, installUrl: undefined } }
      }
      return { ok: true, value }
    } catch (error) {
      return failure(error)
    }
  })

  ipcMain.handle(CH.listGitHubRepositories, async (_event, args?: { cursor?: unknown }) => {
    try {
      const cursor = typeof args?.cursor === 'string' ? args.cursor : null
      return { ok: true, value: await client.githubRepositories(cursor) }
    } catch (error) {
      return failure(error)
    }
  })

  // D4: a repository the account's GitHub installations reach, with no clone here. The sandbox
  // clones it; nothing touches this computer's disk. With a provision id the window shows the build
  // sheet: progress streams on the build log channel and Cancel aborts it (GH-CREATE-SHEET).
  ipcMain.handle(CH.createFromGitHub, async (event, args?: CreateFromGitHubArgs) => {
    const slug = typeof args?.repoUrl === 'string' ? githubRepoSlug(args.repoUrl) : null
    if (!slug) {
      return { ok: false, code: 'failed', message: 'Not a GitHub repository.' }
    }
    // The name typed in the composer, as the owned create sends it; else lists show the repo name.
    const title = typeof args?.title === 'string' ? args.title.trim().slice(0, 120) : ''
    const provisionId = matching(args?.provisionId, CLOUD_CREATE_PROVISION_ID)
    const idempotencyKey = matching(args?.idempotencyKey, CLOUD_CREATE_IDEMPOTENCY_KEY)
    const controller = provisionId ? new AbortController() : null
    if (provisionId && controller) {
      activeProvisionControllers.set(provisionId, controller)
    }
    try {
      return await createCloudWorkspaceFromGitHub(
        client,
        { slug, title, provisionId, idempotencyKey },
        {
          ...(controller ? { signal: controller.signal } : {}),
          onLog: (chunk) => {
            if (provisionId && !event.sender.isDestroyed()) {
              event.sender.send('ephemeralVm:provisionEvent', {
                provisionId,
                stream: 'stderr',
                chunk
              })
            }
          }
        }
      )
    } finally {
      if (provisionId && activeProvisionControllers.get(provisionId) === controller) {
        activeProvisionControllers.delete(provisionId)
      }
    }
  })
}

type CreateFromGitHubArgs =
  | { repoUrl?: unknown; title?: unknown; provisionId?: unknown; idempotencyKey?: unknown }
  | undefined

function matching(value: unknown, pattern: RegExp): string | null {
  return typeof value === 'string' && pattern.test(value) ? value : null
}
