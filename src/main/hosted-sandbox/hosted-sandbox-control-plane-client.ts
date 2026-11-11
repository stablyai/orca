// HTTPS client for the Orca sandbox control plane. The desktop holds only a short-lived Orca token;
// the provider credential never leaves the control plane.
import {
  createHostedSandboxRequest,
  type HostedSandboxControlPlaneClientOptions
} from './hosted-sandbox-request'

export {
  createHostedSandboxRequest,
  type HostedSandboxControlPlaneClientOptions,
  type HostedSandboxRequest
} from './hosted-sandbox-request'
import {
  HostedSandboxDesktopResponseSchema,
  HostedSandboxDestroyResponseSchema,
  type HostedSandboxDestroyResponse,
  HostedSandboxConfigResponseSchema,
  HostedGithubConnectResponseSchema,
  type HostedSandboxConfigResponse,
  HostedArchiveResponseSchema,
  HostedWakeResponseSchema,
  HostedWorkspaceStatusResponseSchema,
  type HostedArchiveRequest,
  type HostedArchiveResponse,
  type HostedWakeResponse,
  type HostedWorkspaceStatus,
  HostedSandboxListResponseSchema,
  HostedSandboxReadyResponseSchema,
  HostedSandboxSshAccessResponseSchema,
  HostedSandboxStatusResponseSchema,
  type HostedSandboxSshAccess,
  type HostedSandboxCreateRequest,
  type HostedSandboxDesktop,
  type HostedSandboxReadyResponse,
  type HostedSandboxView
} from '../../shared/hosted-sandbox/hosted-sandbox-wire'
import {
  HostedBootPlanResponseSchema,
  HostedCloneStatusResponseSchema,
  type HostedCloneStatus
} from '../../shared/hosted-sandbox/hosted-clone-wire'
import {
  HostedGithubRepoAccessResponseSchema,
  HostedGithubRepositoriesResponseSchema,
  type HostedGithubRepoAccessResponse,
  type HostedGithubRepositoriesResponse
} from '../../shared/hosted-sandbox/hosted-github-wire'
import type { z } from 'zod'

type HostedGithubConnectResponse = z.infer<typeof HostedGithubConnectResponseSchema>

export type HostedSandboxControlPlaneClient = {
  create(
    body: HostedSandboxCreateRequest,
    signal?: AbortSignal,
    /** Idempotency-Key: one per user intent; a repeat returns the first create's sandbox (24 h). */
    idempotencyKey?: string
  ): Promise<HostedSandboxReadyResponse>
  get(sandboxId: string, signal?: AbortSignal): Promise<HostedSandboxView>
  /** Whether a create of `repoUrl` would clone it or update a prebuilt copy (environment build). */
  bootPlan(repoUrl: string, signal?: AbortSignal): Promise<'clone' | 'update'>
  /** The background clone a create started (create answered with `clone`). */
  cloneStatus(sandboxId: string, signal?: AbortSignal): Promise<HostedCloneStatus>
  list(signal?: AbortSignal): Promise<HostedSandboxView[]>
  /** `reason` 'idle' is the idle timer; 'user' (or none) is a sleep someone chose. */
  suspend(
    sandboxId: string,
    signal?: AbortSignal,
    reason?: 'idle' | 'user'
  ): Promise<HostedSandboxView>
  resume(sandboxId: string, signal?: AbortSignal): Promise<HostedSandboxReadyResponse>
  renewLease(sandboxId: string, extendMs: number, signal?: AbortSignal): Promise<HostedSandboxView>
  rollover(sandboxId: string, signal?: AbortSignal): Promise<HostedSandboxReadyResponse>
  destroy(sandboxId: string, signal?: AbortSignal): Promise<HostedSandboxDestroyResponse['sandbox']>
  /** Idempotent wake; `waitMs` (max 30s) long-polls until orcad is ready. */
  wake(sandboxId: string, waitMs: number, signal?: AbortSignal): Promise<HostedWakeResponse>
  /** Status panel: state, live VM metrics, uptime, cost so far. */
  workspaceStatus(
    sandboxId: string,
    signal?: AbortSignal
  ): Promise<{ sandbox: HostedSandboxView; status: HostedWorkspaceStatus }>
  /** Forced rehydrate for an unresponsive workspace (same disk, new session). */
  restart(sandboxId: string, signal?: AbortSignal): Promise<HostedSandboxReadyResponse>
  archive(
    sandboxId: string,
    body: HostedArchiveRequest,
    signal?: AbortSignal
  ): Promise<HostedSandboxView>
  archiveInfo(sandboxId: string, signal?: AbortSignal): Promise<HostedArchiveResponse['archive']>
  unarchive(sandboxId: string, signal?: AbortSignal): Promise<HostedSandboxReadyResponse>
  /** Installs (or revokes) one desktop's key in the running VM's sshd; answers its pinned host key. */
  installSshKey(
    sandboxId: string,
    publicKey: string,
    signal?: AbortSignal
  ): Promise<HostedSandboxSshAccess>
  removeSshKey(
    sandboxId: string,
    publicKey: string,
    signal?: AbortSignal
  ): Promise<HostedSandboxSshAccess>
  /** Starts the VM's remote desktop (idempotent); it listens on the VM's loopback only. */
  startDesktop(sandboxId: string, signal?: AbortSignal): Promise<HostedSandboxDesktop>
  /** Product constants and measured timings (GET /v1/config). */
  config(signal?: AbortSignal): Promise<HostedSandboxConfigResponse>
  /**
   * Starts binding a GitHub App installation to the account; the browser finishes it. With a repo,
   * the install page preselects it (given its ids) and returns to the setup session afterwards.
   */
  connectGitHub(
    signal?: AbortSignal,
    target?: HostedGithubConnectTarget
  ): Promise<HostedGithubConnectResponse>
  /** Whether Orca Cloud can clone this https GitHub repository for the account. */
  githubRepoAccess(
    query: { repo: string; setupSessionId?: string; repoId?: number; ownerId?: number },
    signal?: AbortSignal
  ): Promise<HostedGithubRepoAccessResponse>
  /** Repositories the account's GitHub installations reach (one page). */
  githubRepositories(
    cursor?: string | null,
    signal?: AbortSignal
  ): Promise<HostedGithubRepositoriesResponse>
}

export type HostedGithubConnectTarget = {
  repo: string
  setupSessionId?: string
  repoId?: number
  ownerId?: number
}

export function createHostedSandboxControlPlaneClient(
  options: HostedSandboxControlPlaneClientOptions
): HostedSandboxControlPlaneClient {
  const call = createHostedSandboxRequest(options)
  const sandboxPath = (id: string, suffix = ''): string =>
    `v1/sandboxes/${encodeURIComponent(id)}${suffix}`

  return {
    create: (body, signal, idempotencyKey) =>
      call('POST', 'v1/sandboxes', HostedSandboxReadyResponseSchema, {
        body,
        kind: 'boot',
        signal,
        ...(idempotencyKey ? { headers: { 'idempotency-key': idempotencyKey } } : {}),
        // The repo clones after the sandbox is up; the driver shows it as its own step.
        // An environment boot reports its incremental fetch as an update (`clone.mode`).
        features: ['clone-progress', 'repo-update']
      }),
    bootPlan: async (repoUrl, signal) =>
      (
        await call(
          'GET',
          `v1/sandboxes/boot-plan?repo=${encodeURIComponent(repoUrl)}`,
          HostedBootPlanResponseSchema,
          { kind: 'control', signal }
        )
      ).repo,
    cloneStatus: async (id, signal) =>
      (
        await call('GET', sandboxPath(id, '/clone'), HostedCloneStatusResponseSchema, {
          kind: 'control',
          signal
        })
      ).clone,
    get: async (id, signal) =>
      (
        await call('GET', sandboxPath(id), HostedSandboxStatusResponseSchema, {
          kind: 'control',
          signal
        })
      ).sandbox,
    list: async (signal) =>
      (
        await call('GET', 'v1/sandboxes', HostedSandboxListResponseSchema, {
          kind: 'control',
          signal
        })
      ).sandboxes,
    suspend: async (id, signal, reason) =>
      (
        await call('POST', sandboxPath(id, '/suspend'), HostedSandboxStatusResponseSchema, {
          ...(reason ? { body: { reason } } : {}),
          kind: 'control',
          signal
        })
      ).sandbox,
    resume: (id, signal) =>
      call('POST', sandboxPath(id, '/resume'), HostedSandboxReadyResponseSchema, {
        kind: 'boot',
        signal
      }),
    renewLease: async (id, extendMs, signal) =>
      (
        await call('POST', sandboxPath(id, '/lease'), HostedSandboxStatusResponseSchema, {
          body: { extendMs },
          kind: 'control',
          signal
        })
      ).sandbox,
    rollover: (id, signal) =>
      call('POST', sandboxPath(id, '/rollover'), HostedSandboxReadyResponseSchema, {
        kind: 'boot',
        signal
      }),
    destroy: async (id, signal) =>
      (
        await call('DELETE', sandboxPath(id), HostedSandboxDestroyResponseSchema, {
          kind: 'control',
          signal
        })
      ).sandbox,
    wake: (id, waitMs, signal) =>
      call(
        'POST',
        `${sandboxPath(id, '/wake')}?wait=${Math.max(0, Math.min(30_000, Math.floor(waitMs)))}ms`,
        HostedWakeResponseSchema,
        { kind: 'control', signal }
      ),
    workspaceStatus: (id, signal) =>
      call('GET', sandboxPath(id, '/status'), HostedWorkspaceStatusResponseSchema, {
        kind: 'control',
        signal
      }),
    restart: (id, signal) =>
      call('POST', sandboxPath(id, '/restart'), HostedSandboxReadyResponseSchema, {
        kind: 'boot',
        signal
      }),
    archive: async (id, body, signal) =>
      (
        await call('POST', sandboxPath(id, '/archive'), HostedSandboxStatusResponseSchema, {
          body,
          kind: 'boot',
          signal
        })
      ).sandbox,
    archiveInfo: async (id, signal) =>
      (
        await call('GET', sandboxPath(id, '/archive'), HostedArchiveResponseSchema, {
          kind: 'control',
          signal
        })
      ).archive,
    unarchive: (id, signal) =>
      call('POST', sandboxPath(id, '/unarchive'), HostedSandboxReadyResponseSchema, {
        kind: 'boot',
        signal
      }),
    installSshKey: async (id, publicKey, signal) =>
      (
        await call('POST', sandboxPath(id, '/ssh-keys'), HostedSandboxSshAccessResponseSchema, {
          body: { publicKey },
          kind: 'control',
          signal
        })
      ).ssh,
    removeSshKey: async (id, publicKey, signal) =>
      (
        await call('DELETE', sandboxPath(id, '/ssh-keys'), HostedSandboxSshAccessResponseSchema, {
          body: { publicKey },
          kind: 'control',
          signal
        })
      ).ssh,
    startDesktop: async (id, signal) =>
      (
        await call('POST', sandboxPath(id, '/desktop'), HostedSandboxDesktopResponseSchema, {
          kind: 'control',
          signal
        })
      ).desktop,
    config: (signal) =>
      call('GET', 'v1/config', HostedSandboxConfigResponseSchema, { kind: 'control', signal }),
    connectGitHub: (signal, target) =>
      call('POST', 'v1/github/connect', HostedGithubConnectResponseSchema, {
        ...(target ? { body: target } : {}),
        kind: 'control',
        signal
      }),
    githubRepoAccess: (query, signal) => {
      const params = new URLSearchParams({ repo: query.repo })
      if (query.setupSessionId) {
        params.set('session', query.setupSessionId)
      }
      if (query.repoId) {
        params.set('repoId', String(query.repoId))
      }
      if (query.ownerId) {
        params.set('ownerId', String(query.ownerId))
      }
      return call('GET', `v1/github/repo-access?${params}`, HostedGithubRepoAccessResponseSchema, {
        kind: 'control',
        signal
      })
    },
    githubRepositories: (cursor, signal) =>
      call(
        'GET',
        cursor
          ? `v1/github/repositories?cursor=${encodeURIComponent(cursor)}`
          : 'v1/github/repositories',
        HostedGithubRepositoriesResponseSchema,
        { kind: 'control', signal }
      )
  }
}
