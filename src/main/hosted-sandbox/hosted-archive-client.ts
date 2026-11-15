// Archive calls on the Orca sandbox control plane: archive, its metadata, and (ARCHIVE-HOOK) the
// repo's orca.yaml archive hook run in the VM before an archive or delete.
import {
  HostedArchiveResponseSchema,
  HostedSandboxStatusResponseSchema,
  type HostedArchiveRequest,
  type HostedArchiveResponse,
  type HostedSandboxView
} from '../../shared/hosted-sandbox/hosted-sandbox-wire'
import {
  HostedArchiveHookResponseSchema,
  HostedArchiveHookStateResponseSchema,
  type HostedArchiveHookMemo,
  type HostedArchiveHookResult
} from '../../shared/hosted-sandbox/hosted-archive-hook-wire'
import type { HostedSandboxRequest } from './hosted-sandbox-request'

export type HostedArchiveClient = {
  archive(
    sandboxId: string,
    body: HostedArchiveRequest,
    signal?: AbortSignal
  ): Promise<HostedSandboxView>
  archiveInfo(sandboxId: string, signal?: AbortSignal): Promise<HostedArchiveResponse['archive']>
  /** Runs the repo's orca.yaml archive hook in the VM; asleep, only with `wake` (else it answers `asleep`). */
  runArchiveHook(
    sandboxId: string,
    body: { wake?: boolean },
    signal?: AbortSignal
  ): Promise<HostedArchiveHookResult>
  /** What the control plane knows about the hook without touching the VM. */
  archiveHookState(
    sandboxId: string,
    signal?: AbortSignal
  ): Promise<{ memo: HostedArchiveHookMemo | null; running: boolean; archived?: boolean }>
}

export function archiveClientMethods(
  call: HostedSandboxRequest,
  sandboxPath: (id: string, suffix?: string) => string
): HostedArchiveClient {
  return {
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
    runArchiveHook: async (id, body, signal) =>
      (
        await call('POST', sandboxPath(id, '/archive-hook'), HostedArchiveHookResponseSchema, {
          body,
          kind: 'hook',
          signal
        })
      ).archiveHook,
    archiveHookState: async (id, signal) =>
      (
        await call('GET', sandboxPath(id, '/archive-hook'), HostedArchiveHookStateResponseSchema, {
          kind: 'control',
          signal
        })
      ).archiveHook
  }
}
