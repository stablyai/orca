import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import { z } from 'zod'
import type {
  RecoveryPresentationClientKind,
  RecoveryPresentationViewExport
} from '../../../shared/cross-machine-recovery-descriptor'
import {
  MAX_RECOVERY_PRESENTATION_CLIENTS,
  MAX_RECOVERY_PRESENTATION_PUBLISH_BYTES,
  MAX_RECOVERY_PRESENTATION_WORKSPACES,
  MAX_RECOVERY_PRESENTATION_WORKSPACE_VIEW_BYTES,
  RECOVERY_PRESENTATION_RETENTION_MS,
  type RecoveryPresentationPublishParams,
  type RecoveryPresentationPublishResult,
  type RecoveryPresentationWorkspaceRef
} from '../../../shared/cross-machine-recovery-presentation-types'
import { readNodeFileWithinLimit } from '../../../shared/node-bounded-file-reader'
import {
  JsonStringifyByteLimitError,
  stringifyJsonWithinByteLimit
} from '../../../shared/node-bounded-json-stringify'
import { RecoveryLayoutSchema } from '../../../shared/rpc-contract/cross-machine-recovery-layout-params'
import {
  RecoveryPresentationFocusSchema,
  RecoveryPresentationWorkspaceRefSchema
} from '../../../shared/rpc-contract/cross-machine-recovery-params'
import {
  durableWriteTempPath,
  removeStaleDurableWriteTempFiles,
  renameDurable,
  writeTempFileDurable
} from '../../durable-file-write'
import { withFileTransactionLock } from '../../file-transaction-lock'

export const CROSS_MACHINE_RECOVERY_PRESENTATION_FILE = 'cross-machine-recovery-presentations.json'

const MAX_STORE_BYTES =
  MAX_RECOVERY_PRESENTATION_CLIENTS * MAX_RECOVERY_PRESENTATION_PUBLISH_BYTES * 2
const STALE_WRITE_TEMP_FILE_AGE_MS = 24 * 60 * 60 * 1000

const StampSchema = z.number().finite().nonnegative()

const StoredWorkspaceSchema = z
  .object({
    workspace: RecoveryPresentationWorkspaceRefSchema,
    view: RecoveryLayoutSchema,
    focus: RecoveryPresentationFocusSchema,
    lastHumanInputAt: StampSchema.nullable(),
    lastHumanFocusAt: StampSchema.nullable(),
    lastHumanInputAtByPaneKey: z.record(z.string(), StampSchema)
  })
  .strict()

const StoredClientSchema = z
  .object({
    clientKey: z.string().min(1),
    clientKind: z.enum(['local-renderer', 'paired-device']),
    clientInstanceId: z.string().min(1),
    clientName: z.string(),
    clientRevision: z.number().int().nonnegative(),
    hostReceivedAt: StampSchema,
    workspaces: z.array(StoredWorkspaceSchema)
  })
  .strict()

const StoreStateSchema = z.object({ version: z.literal(1), clients: z.array(StoredClientSchema) })

type StoredClient = z.infer<typeof StoredClientSchema>

export type RecoveryPresentationWorkspaceKey =
  | { kind: 'worktree'; worktreeId: string; instanceId: string | null }
  | { kind: 'folder'; folderWorkspaceId: string }

export type RecoveryPresentationWorkspaceViews = {
  views: RecoveryPresentationViewExport[]
  preferredClientKey: string | null
}

function fitsWithin(value: unknown, maxBytes: number): boolean {
  try {
    stringifyJsonWithinByteLimit(value, maxBytes)
    return true
  } catch (error) {
    if (error instanceof JsonStringifyByteLimitError) {
      return false
    }
    throw error
  }
}

function stampAge(hostReceivedAt: number, msSince: number | null): number | null {
  return msSince === null ? null : Math.max(0, hostReceivedAt - msSince)
}

function matchesWorkspace(
  ref: RecoveryPresentationWorkspaceRef,
  key: RecoveryPresentationWorkspaceKey
): boolean {
  if (ref.kind === 'folder' || key.kind === 'folder') {
    return ref.kind === 'folder' && key.kind === 'folder'
      ? ref.folderWorkspaceId === key.folderWorkspaceId
      : false
  }
  // Why: a worktree path can be reused by a later workspace; a view pinned to another instance
  // describes the old one.
  return (
    ref.worktreeId === key.worktreeId &&
    (ref.instanceId === undefined || key.instanceId === null || ref.instanceId === key.instanceId)
  )
}

function newest(values: readonly (number | null)[]): number | null {
  const present = values.filter((value) => value !== null)
  return present.length === 0 ? null : Math.max(...present)
}

function preferredClientKey(views: readonly RecoveryPresentationViewExport[]): string | null {
  const byStamp = (stamp: (view: RecoveryPresentationViewExport) => number | null) => {
    const best = newest(views.map(stamp))
    return best === null ? undefined : views.find((view) => stamp(view) === best)
  }
  const preferred =
    byStamp((view) => view.lastHumanInputAt) ??
    byStamp((view) => view.lastHumanFocusAt) ??
    byStamp((view) => view.hostReceivedAt)
  return preferred?.clientKey ?? null
}

/** Durable latest-by-revision client views per host, bounded in clients, age and bytes. */
export class CrossMachineRecoveryPresentationStore {
  private readonly filePath: string

  constructor(stateDirectory: string) {
    this.filePath = join(stateDirectory, CROSS_MACHINE_RECOVERY_PRESENTATION_FILE)
  }

  record(
    clientKey: string,
    clientKind: RecoveryPresentationClientKind,
    params: RecoveryPresentationPublishParams,
    hostReceivedAt: number
  ): Promise<RecoveryPresentationPublishResult> {
    if (
      params.workspaces.length > MAX_RECOVERY_PRESENTATION_WORKSPACES ||
      !fitsWithin(params, MAX_RECOVERY_PRESENTATION_PUBLISH_BYTES) ||
      params.workspaces.some(
        (workspace) => !fitsWithin(workspace.view, MAX_RECOVERY_PRESENTATION_WORKSPACE_VIEW_BYTES)
      )
    ) {
      return Promise.resolve({ ok: false, reason: 'too-large' })
    }
    return withFileTransactionLock(this.filePath, async () => {
      const clients = this.retained(await this.readClients(), hostReceivedAt)
      const existing = clients.find((client) => client.clientKey === clientKey)
      // Why: a reinstalled client restarts its revisions under the same key; only the same
      // instance's older revision is stale.
      if (
        existing &&
        existing.clientInstanceId === params.clientInstanceId &&
        params.clientRevision <= existing.clientRevision
      ) {
        return {
          ok: false,
          reason: 'stale-revision',
          acknowledgedRevision: existing.clientRevision
        }
      }
      const next: StoredClient = {
        clientKey,
        clientKind,
        clientInstanceId: params.clientInstanceId,
        clientName: params.clientName,
        clientRevision: params.clientRevision,
        hostReceivedAt,
        workspaces: params.workspaces.map(({ workspace, view, focus, input }) => ({
          workspace,
          view,
          focus,
          lastHumanInputAt: stampAge(hostReceivedAt, input.msSinceHumanInput),
          lastHumanFocusAt: stampAge(hostReceivedAt, input.msSinceHumanFocus),
          lastHumanInputAtByPaneKey: Object.fromEntries(
            Object.entries(input.msSinceHumanInputByPaneKey).map(([paneKey, msSince]) => [
              paneKey,
              Math.max(0, hostReceivedAt - msSince)
            ])
          )
        }))
      }
      const kept = [next, ...clients.filter((client) => client.clientKey !== clientKey)]
        .sort((a, b) => b.hostReceivedAt - a.hostReceivedAt)
        .slice(0, MAX_RECOVERY_PRESENTATION_CLIENTS)
      await this.publish(kept)
      return { ok: true, acknowledgedRevision: params.clientRevision, hostReceivedAt }
    })
  }

  listForWorkspace(
    key: RecoveryPresentationWorkspaceKey,
    now: number
  ): Promise<RecoveryPresentationWorkspaceViews> {
    return withFileTransactionLock(this.filePath, async () => {
      const views = this.retained(await this.readClients(), now).flatMap((client) =>
        client.workspaces
          .filter((workspace) => matchesWorkspace(workspace.workspace, key))
          .map((workspace): RecoveryPresentationViewExport => ({
            clientKey: client.clientKey,
            clientInstanceId: client.clientInstanceId,
            clientName: client.clientName,
            clientKind: client.clientKind,
            hostReceivedAt: client.hostReceivedAt,
            lastHumanInputAt: workspace.lastHumanInputAt,
            lastHumanFocusAt: workspace.lastHumanFocusAt,
            focus: workspace.focus,
            view: workspace.view
          }))
      )
      return { views, preferredClientKey: preferredClientKey(views) }
    })
  }

  private retained(clients: StoredClient[], now: number): StoredClient[] {
    return clients.filter(
      (client) => now - client.hostReceivedAt <= RECOVERY_PRESENTATION_RETENTION_MS
    )
  }

  private async readClients(): Promise<StoredClient[]> {
    let raw: string
    try {
      raw = (await readNodeFileWithinLimit(this.filePath, MAX_STORE_BYTES)).buffer.toString('utf8')
    } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
        return []
      }
      throw error
    }
    let json: unknown
    try {
      json = JSON.parse(raw)
    } catch {
      // Why: views are advisory; a torn or corrupt file only costs the next export its client view.
      return []
    }
    const parsed = StoreStateSchema.safeParse(json)
    return parsed.success ? parsed.data.clients : []
  }

  private async publish(clients: StoredClient[]): Promise<void> {
    const { serialized } = stringifyJsonWithinByteLimit({ version: 1, clients }, MAX_STORE_BYTES)
    await removeStaleDurableWriteTempFiles(this.filePath, {
      minimumAgeMs: STALE_WRITE_TEMP_FILE_AGE_MS
    })
    const tempPath = durableWriteTempPath(this.filePath)
    try {
      await writeTempFileDurable(tempPath, serialized, 0o600)
      await renameDurable(tempPath, this.filePath)
    } finally {
      await rm(tempPath, { force: true }).catch(() => {})
    }
  }
}
