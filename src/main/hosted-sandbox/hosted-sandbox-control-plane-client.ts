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

export type HostedSandboxControlPlaneClient = {
  create(
    body: HostedSandboxCreateRequest,
    signal?: AbortSignal
  ): Promise<HostedSandboxReadyResponse>
  get(sandboxId: string, signal?: AbortSignal): Promise<HostedSandboxView>
  list(signal?: AbortSignal): Promise<HostedSandboxView[]>
  suspend(sandboxId: string, signal?: AbortSignal): Promise<HostedSandboxView>
  resume(sandboxId: string, signal?: AbortSignal): Promise<HostedSandboxReadyResponse>
  renewLease(sandboxId: string, extendMs: number, signal?: AbortSignal): Promise<HostedSandboxView>
  rollover(sandboxId: string, signal?: AbortSignal): Promise<HostedSandboxReadyResponse>
  destroy(sandboxId: string, signal?: AbortSignal): Promise<HostedSandboxView>
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
}

export function createHostedSandboxControlPlaneClient(
  options: HostedSandboxControlPlaneClientOptions
): HostedSandboxControlPlaneClient {
  const call = createHostedSandboxRequest(options)
  const sandboxPath = (id: string, suffix = ''): string =>
    `v1/sandboxes/${encodeURIComponent(id)}${suffix}`

  return {
    create: (body, signal) =>
      call('POST', 'v1/sandboxes', HostedSandboxReadyResponseSchema, {
        body,
        kind: 'boot',
        signal
      }),
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
    suspend: async (id, signal) =>
      (
        await call('POST', sandboxPath(id, '/suspend'), HostedSandboxStatusResponseSchema, {
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
        await call('DELETE', sandboxPath(id), HostedSandboxStatusResponseSchema, {
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
      ).desktop
  }
}
