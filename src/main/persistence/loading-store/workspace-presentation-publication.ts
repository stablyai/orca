import type { WorkspaceSessionState } from '../../../shared/workspace-session-state-types'
import type { PersistedState } from '../../../shared/persisted-state-types'
import type { ExecutionHostId } from '../../../shared/execution-host'
import {
  isWorkspacePresentationKey,
  type WorkspacePresentationKey,
  type WorkspacePresentation,
  type WorkspacePresentationDocuments
} from '../../../shared/workspace-presentation'
import { presentationSourceBaselines } from '../../../shared/workspace-presentation-reconcile'
import { settleWorkspacePresentation } from '../../../shared/workspace-presentation-settlement'

export type PresentationState = Pick<
  PersistedState,
  'workspaceSession' | 'workspaceSessionsByHostId'
> &
  WorkspacePresentationDocuments

type Index = {
  documents: Map<WorkspacePresentationKey, WorkspacePresentation>
  hosts: Map<ExecutionHostId, Map<string, Set<WorkspacePresentationKey>>>
  sessions: Map<ExecutionHostId, WorkspaceSessionState>
  workspaces: Map<string, Set<WorkspacePresentationKey>>
  pending: Set<WorkspacePresentationKey>
}
const journals = new WeakMap<
  PresentationState,
  Set<Map<WorkspacePresentationKey, WorkspacePresentation | undefined>>
>()
function recordBefore(state: PresentationState, key: WorkspacePresentationKey): void {
  for (const journal of journals.get(state) ?? []) {
    if (!journal.has(key)) {
      journal.set(key, state[key])
    }
  }
}
const indexes = new WeakMap<PresentationState, Index>()
function indexFor(state: PresentationState): Index {
  let index = indexes.get(state)
  if (!index) {
    index = {
      documents: new Map(),
      hosts: new Map(),
      sessions: new Map(),
      workspaces: new Map(),
      pending: new Set()
    }
    indexes.set(state, index)
    for (const key of Object.keys(state)) {
      if (isWorkspacePresentationKey(key) && state[key]) {
        updateIndex(index, key, state[key])
      }
    }
  }
  return index
}
function updateIndex(
  index: Index,
  key: WorkspacePresentationKey,
  document: WorkspacePresentation | undefined
): void {
  const previous = index.documents.get(key)
  if (
    previous &&
    document &&
    previous.baseline.length === document.baseline.length &&
    previous.baseline.every((entry, at) => {
      const source = document.baseline[at].source
      return (
        entry.source.hostId === source.hostId && entry.source.workspaceId === source.workspaceId
      )
    })
  ) {
    index.documents.set(key, document)
    index.pending.add(key)
    return
  }
  for (const id of previous
    ? [previous.displayWorkspaceId, ...previous.baseline.map(({ source }) => source.workspaceId)]
    : []) {
    const keys = index.workspaces.get(id)
    keys?.delete(key)
    if (!keys?.size) {
      index.workspaces.delete(id)
    }
  }
  for (const { source } of previous?.baseline ?? []) {
    const sources = index.hosts.get(source.hostId)
    const keys = sources?.get(source.workspaceId)
    keys?.delete(key)
    if (!keys?.size) {
      sources?.delete(source.workspaceId)
    }
    if (!sources?.size) {
      index.hosts.delete(source.hostId)
      index.sessions.delete(source.hostId)
    }
  }
  index.documents.delete(key)
  index.pending.delete(key)
  if (!document) {
    return
  }
  index.documents.set(key, document)
  index.pending.add(key)
  for (const id of [
    document.displayWorkspaceId,
    ...document.baseline.map(({ source }) => source.workspaceId)
  ]) {
    const keys = index.workspaces.get(id) ?? new Set()
    keys.add(key)
    index.workspaces.set(id, keys)
  }
  for (const { source } of document.baseline) {
    let sources = index.hosts.get(source.hostId)
    if (!sources) {
      sources = new Map()
      index.hosts.set(source.hostId, sources)
    }
    let keys = sources.get(source.workspaceId)
    if (!keys) {
      keys = new Set()
      sources.set(source.workspaceId, keys)
    }
    keys.add(key)
  }
}
export function writeWorkspacePresentation(
  state: PresentationState,
  key: WorkspacePresentationKey,
  document: WorkspacePresentation | undefined
): void {
  const index = indexFor(state)
  recordBefore(state, key)
  if (document) {
    state[key] = document
  } else {
    delete state[key]
  }
  updateIndex(index, key, document)
}
export function storedWorkspacePresentations(
  state: PresentationState,
  keys?: readonly string[]
): WorkspacePresentationDocuments {
  const index = indexFor(state)
  return keys
    ? Object.fromEntries(
        keys.flatMap((key) => {
          const document = isWorkspacePresentationKey(key) ? index.documents.get(key) : undefined
          return document ? [[key, document]] : []
        })
      )
    : Object.fromEntries(index.documents)
}
/** Literal source selectors can address client placement without becoming membership aliases. */
export function storedWorkspacePresentationFor(state: PresentationState, workspace: string) {
  const index = indexFor(state)
  const keys = index.workspaces.get(workspace)
  if (keys?.size !== 1) {
    return undefined
  }
  const key = keys.values().next().value
  const document = key ? index.documents.get(key) : undefined
  return key && document ? { key, document } : undefined
}
/** One reconciliation per affected document in the source write's existing profile transaction. */
export function reconcileStoredWorkspacePresentations(
  state: PresentationState,
  hostId?: ExecutionHostId
): string[] {
  const index = indexFor(state)
  const dirty: string[] = []
  const affected = new Set(index.pending)
  index.pending.clear()
  for (const host of hostId ? [hostId] : index.hosts.keys()) {
    const current =
      host === 'local' ? state.workspaceSession : state.workspaceSessionsByHostId?.[host]
    const previous = index.sessions.get(host)
    if (current === previous) {
      continue
    }
    if (current) {
      index.sessions.set(host, current)
    } else {
      index.sessions.delete(host)
    }
    const changedSources = new Set<string>()
    for (const field of [
      'unifiedTabs',
      'tabGroups',
      'tabGroupLayouts',
      'activeGroupIdByWorktree'
    ] as const) {
      const before = previous?.[field],
        after = current?.[field]
      if (before === after) {
        continue
      }
      for (const id of new Set([...Object.keys(before ?? {}), ...Object.keys(after ?? {})])) {
        if (before?.[id] !== after?.[id]) {
          changedSources.add(id)
        }
      }
    }
    for (const id of changedSources) {
      for (const key of index.hosts.get(host)?.get(id) ?? []) {
        affected.add(key)
      }
    }
  }
  for (const key of affected) {
    const document = index.documents.get(key)
    if (!document) {
      continue
    }
    const next = settleWorkspacePresentation(
      document,
      presentationSourceBaselines(document, (host) =>
        host === 'local'
          ? state.workspaceSession
          : (state.workspaceSessionsByHostId?.[host] ?? {
              tabsByWorktree: {},
              activeTabIdByWorktree: {}
            })
      )
    )
    if (next !== document) {
      // Settlement cannot change the source bindings; keep the source index intact.
      recordBefore(state, key)
      if (!next.tabs.length && !next.groups.length) {
        writeWorkspacePresentation(state, key, undefined)
      } else {
        state[key] = next
        index.documents.set(key, next)
      }
      dirty.push(key)
    }
  }
  return dirty
}
/** Conditional receipts restore only this mutation, leaving later owner edits intact. */
export function presentationMutation(state: PresentationState) {
  const before = new Map<WorkspacePresentationKey, WorkspacePresentation | undefined>()
  let active = journals.get(state)
  if (!active) {
    active = new Set()
    journals.set(state, active)
  }
  active.add(before)
  const finish = () => {
    active.delete(before)
    if (!active.size) {
      journals.delete(state)
    }
    const written = new Map([...before.keys()].map((key) => [key, state[key]]))
    return () => {
      for (const [key, value] of before) {
        if (state[key] === written.get(key)) {
          writeWorkspacePresentation(state, key, value)
        }
      }
    }
  }
  return Object.assign(finish, { changedKeys: () => [...before.keys()] })
}
