import { isDeepStrictEqual } from 'node:util'
import type {
  RemoteWorkspaceSession,
  RemoteWorkspaceSnapshot
} from '../../shared/remote-workspace-types'

const SNAPSHOT_SCHEMA_VERSION = 1

function emptyRemoteSession(): RemoteWorkspaceSession {
  return {
    activeWorktreePath: null,
    activeTabId: null,
    tabsByWorktreePath: {},
    terminalLayoutsByTabId: {}
  }
}

function normalizeOptionalStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) {
    return undefined
  }
  const normalized = value.filter((entry): entry is string => typeof entry === 'string')
  return normalized.length > 0 ? normalized : undefined
}

function normalizeOptionalRecord<T extends Record<string, unknown>>(value: unknown): T | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return undefined
  }
  return Object.keys(value).length > 0 ? (value as T) : undefined
}

function normalizeRemoteSession(raw: unknown): RemoteWorkspaceSession {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return emptyRemoteSession()
  }
  const input = raw as Partial<RemoteWorkspaceSession>
  return {
    activeWorktreePath:
      typeof input.activeWorktreePath === 'string' ? input.activeWorktreePath : null,
    activeTabId: typeof input.activeTabId === 'string' ? input.activeTabId : null,
    tabsByWorktreePath:
      input.tabsByWorktreePath &&
      typeof input.tabsByWorktreePath === 'object' &&
      !Array.isArray(input.tabsByWorktreePath)
        ? input.tabsByWorktreePath
        : {},
    terminalLayoutsByTabId:
      input.terminalLayoutsByTabId &&
      typeof input.terminalLayoutsByTabId === 'object' &&
      !Array.isArray(input.terminalLayoutsByTabId)
        ? input.terminalLayoutsByTabId
        : {},
    activeWorktreePathsOnShutdown: normalizeOptionalStringArray(
      input.activeWorktreePathsOnShutdown
    ),
    activeTabIdByWorktreePath: normalizeOptionalRecord<Record<string, string | null>>(
      input.activeTabIdByWorktreePath
    ),
    remoteSessionIdsByTabId: normalizeOptionalRecord<Record<string, string>>(
      input.remoteSessionIdsByTabId
    ),
    lastVisitedAtByWorktreePath: normalizeOptionalRecord<Record<string, number>>(
      input.lastVisitedAtByWorktreePath
    ),
    // Dropping this made the field write-only: every read stripped it, and the patch guard below
    // compares normalized sessions, so a change that only sets it looked like no change at all.
    defaultTerminalTabsAppliedByWorktreePath: normalizeOptionalRecord<Record<string, true>>(
      input.defaultTerminalTabsAppliedByWorktreePath
    )
  }
}

export function normalizeSnapshot(
  raw: unknown,
  fallbackNamespace: string
): RemoteWorkspaceSnapshot {
  const input = raw as Partial<RemoteWorkspaceSnapshot> | null
  return {
    namespace: typeof input?.namespace === 'string' ? input.namespace : fallbackNamespace,
    revision:
      typeof input?.revision === 'number' && Number.isFinite(input.revision) ? input.revision : 0,
    updatedAt:
      typeof input?.updatedAt === 'number' && Number.isFinite(input.updatedAt)
        ? input.updatedAt
        : 0,
    schemaVersion:
      typeof input?.schemaVersion === 'number' && Number.isFinite(input.schemaVersion)
        ? input.schemaVersion
        : SNAPSHOT_SCHEMA_VERSION,
    session: normalizeRemoteSession(input?.session)
  }
}

export function remoteWorkspaceSessionMatchesSnapshot(
  snapshot: RemoteWorkspaceSnapshot | undefined,
  session: RemoteWorkspaceSession
): boolean {
  if (!snapshot) {
    return false
  }
  return isDeepStrictEqual(
    normalizeRemoteSession(snapshot.session),
    normalizeRemoteSession(session)
  )
}
