import type { AgentStatusIpcPayload } from '../../../shared/agent-status-ipc-payload'
import {
  CROSS_MACHINE_RECOVERY_DESCRIPTOR_VERSION,
  MAX_RECOVERY_DESCRIPTOR_BYTES,
  type OrcaRecoveryDescriptorV1,
  type RecoveryExportResult,
  type RecoveryLayout,
  type RecoveryWorkspaceMeta
} from '../../../shared/cross-machine-recovery-descriptor'
import { getAppEnvironment } from '../../../shared/app-environment'
import {
  JsonStringifyByteLimitError,
  stringifyJsonWithinByteLimit
} from '../../../shared/node-bounded-json-stringify'
import type { Repo } from '../../../shared/repo-types'
import { structuredAgentSessionTabId } from '../../../shared/structured-agent-session-projection'
import type { WorkspaceSessionState } from '../../../shared/workspace-session-state-types'
import type { Worktree } from '../../../shared/worktree/types'
import { getStructuredAgentSessionHost } from '../../native-chat/agent-session-wire/structured-agent-session-registry'
import { getProfileUserDataPath } from '../../orca-profiles/profile-storage-paths'
import type { OrcaRuntimeService } from '../orca-runtime'
import { hasPersistedStructuredAgentSessionStore } from '../structured-agent-session-runtime'
import { getCrossMachineRecoveryPresentationStore } from './presentation-store-instance'
import type { RecoveryPresentationWorkspaceViews } from './presentation-store'
import { collectRecoveryBindings, type StructuredRecoveryRecord } from './recovery-bindings'
import { projectRecoveryLayout } from './recovery-layout-projection'

export type CrossMachineRecoveryRuntime = Pick<
  OrcaRuntimeService,
  | 'getRuntimeId'
  | 'readMachineName'
  | 'showManagedWorktree'
  | 'readCrossMachineRecoveryHostState'
  | 'ensureStructuredAgentSessionHost'
>

export type RecoveryExportSources = {
  now: number
  source: OrcaRecoveryDescriptorV1['source']
  repo: Repo
  worktree: Worktree
  session: WorkspaceSessionState
  liveStatuses: readonly AgentStatusIpcPayload[]
  structuredRecords: readonly StructuredRecoveryRecord[]
  presentation: RecoveryPresentationWorkspaceViews
}

function workspaceMeta(worktree: Worktree): RecoveryWorkspaceMeta {
  return {
    displayName: worktree.displayName,
    comment: worktree.comment,
    linkedIssue: worktree.linkedIssue,
    linkedPR: worktree.linkedPR,
    linkedLinearIssue: worktree.linkedLinearIssue,
    ...(worktree.linkedWorkItem !== undefined ? { linkedWorkItem: worktree.linkedWorkItem } : {}),
    ...(worktree.baseRef !== undefined ? { baseRef: worktree.baseRef } : {}),
    ...(worktree.createdWithAgent !== undefined
      ? { createdWithAgent: worktree.createdWithAgent }
      : {}),
    lastActivityAt: worktree.lastActivityAt,
    isPinned: worktree.isPinned
  }
}

/** Why the id fallback: legacy rows predate instance ids, and the worktree id is stable per path. */
export function recoveryWorkspaceInstanceId(worktree: Worktree): string {
  return worktree.instanceId ?? worktree.id
}

export function buildRecoveryDescriptor(sources: RecoveryExportSources): OrcaRecoveryDescriptorV1 {
  const { repo, worktree, session } = sources
  // Why: SSH workspaces publish no client views, so only host bindings describe them.
  const hostBindingsOnly = Boolean(repo.connectionId)
  const views = hostBindingsOnly ? [] : sources.presentation.views
  return {
    version: CROSS_MACHINE_RECOVERY_DESCRIPTOR_VERSION,
    exportedAt: sources.now,
    source: sources.source,
    repo: {
      id: repo.id,
      path: repo.path,
      displayName: repo.displayName,
      ...(repo.kind !== undefined ? { kind: repo.kind } : {}),
      ...(repo.upstream !== undefined ? { upstream: repo.upstream } : {}),
      ...(repo.worktreeBaseRef !== undefined ? { worktreeBaseRef: repo.worktreeBaseRef } : {})
    },
    workspace: {
      worktreeId: worktree.id,
      instanceId: recoveryWorkspaceInstanceId(worktree),
      path: worktree.path,
      branch: worktree.branch || null,
      meta: workspaceMeta(worktree)
    },
    layout: projectRecoveryLayout(session, worktree.id, worktree.path),
    presentation: {
      views,
      preferredClientKey: hostBindingsOnly ? null : sources.presentation.preferredClientKey,
      freshness: hostBindingsOnly
        ? 'host-bindings-only'
        : views.length > 0
          ? 'client-view'
          : 'host-only'
    },
    bindings: collectRecoveryBindings({
      worktreeId: worktree.id,
      now: sources.now,
      liveStatuses: sources.liveStatuses,
      sleepingRecords: Object.values(session.sleepingAgentSessionsByPaneKey ?? {}),
      structuredRecords: sources.structuredRecords
    })
  }
}

function withoutBrowserPages(layout: RecoveryLayout): RecoveryLayout {
  return { ...layout, browsers: layout.browsers.map((browser) => ({ ...browser, pages: [] })) }
}

function fitsRecoveryCap(descriptor: OrcaRecoveryDescriptorV1): boolean {
  try {
    stringifyJsonWithinByteLimit(descriptor, MAX_RECOVERY_DESCRIPTOR_BYTES)
    return true
  } catch (error) {
    if (error instanceof JsonStringifyByteLimitError) {
      return false
    }
    throw error
  }
}

/** Keeps the descriptor under the transport cap, shedding browser page lists before refusing. */
export function fitRecoveryDescriptor(
  descriptor: OrcaRecoveryDescriptorV1
): OrcaRecoveryDescriptorV1 {
  if (fitsRecoveryCap(descriptor)) {
    return descriptor
  }
  const trimmed: OrcaRecoveryDescriptorV1 = {
    ...descriptor,
    layout: withoutBrowserPages(descriptor.layout),
    presentation: {
      ...descriptor.presentation,
      views: descriptor.presentation.views.map((view) => ({
        ...view,
        view: withoutBrowserPages(view.view)
      }))
    }
  }
  if (fitsRecoveryCap(trimmed)) {
    return trimmed
  }
  throw new Error('recovery_descriptor_too_large')
}

async function readStructuredRecords(
  runtime: CrossMachineRecoveryRuntime,
  worktreeId: string
): Promise<StructuredRecoveryRecord[]> {
  // Why: the record store opens lazily; only a profile that has one needs the host installed.
  if (
    !getStructuredAgentSessionHost() &&
    hasPersistedStructuredAgentSessionStore(getProfileUserDataPath())
  ) {
    await runtime.ensureStructuredAgentSessionHost()
  }
  const host = getStructuredAgentSessionHost()
  if (!host) {
    return []
  }
  return host.deps.store
    .listRecords()
    .filter(
      (record) =>
        record.location.executionHostId === 'local' && record.location.workspaceId === worktreeId
    )
    .map((record) => ({
      record,
      tabId: host.getSessionTabId(record.sessionId) ?? structuredAgentSessionTabId(record.sessionId)
    }))
}

export async function exportRecoveryWorkspace(
  runtime: CrossMachineRecoveryRuntime,
  worktreeSelector: string,
  now: number
): Promise<RecoveryExportResult> {
  const worktree = await runtime.showManagedWorktree(worktreeSelector)
  const { store, agentStatuses } = runtime.readCrossMachineRecoveryHostState()
  const repo = store.getRepos().find((candidate) => candidate.id === worktree.repoId)
  if (!repo) {
    throw new Error('repo_not_found')
  }
  const presentation = await getCrossMachineRecoveryPresentationStore().listForWorkspace(
    repo.kind === 'folder'
      ? { kind: 'folder', folderWorkspaceId: worktree.id }
      : { kind: 'worktree', worktreeId: worktree.id, instanceId: worktree.instanceId ?? null },
    now
  )
  const descriptor = buildRecoveryDescriptor({
    now,
    source: {
      runtimeId: runtime.getRuntimeId(),
      appVersion: getAppEnvironment().getVersion(),
      machineName: runtime.readMachineName(),
      platform: process.platform,
      executionHostId: 'local'
    },
    repo,
    worktree,
    session: store.getWorkspaceSession('local'),
    liveStatuses: agentStatuses,
    structuredRecords: await readStructuredRecords(runtime, worktree.id),
    presentation
  })
  return { descriptor: fitRecoveryDescriptor(descriptor) }
}
