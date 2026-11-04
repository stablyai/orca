import type Database from '../sqlite/sync-database'
import { getDefaultWorkspaceSession } from '../../shared/constants'
import type { WorkspaceSessionState } from '../../shared/workspace-session/workspace-session-state-types'
import { parseJson } from './surface-rows'

export function readSurfaceHostSession(
  db: Database.Database,
  hostId: string
): WorkspaceSessionState {
  const domain = hostId === 'local' ? 'workspaceSession' : 'workspaceSessionsByHostId'
  const payload = db
    .prepare('SELECT payload FROM main.profile_state_documents WHERE domain = ?')
    .get(domain)?.payload
  if (typeof payload !== 'string') {
    return getDefaultWorkspaceSession()
  }
  const value = JSON.parse(payload)
  return {
    ...getDefaultWorkspaceSession(),
    ...(hostId === 'local' ? value : value[hostId])
  }
}

export function surfaceSessionReplacements(
  db: Database.Database,
  hostId: string,
  session: WorkspaceSessionState
): { domain: string; payload: string }[] {
  if (hostId === 'local') {
    return [{ domain: 'workspaceSession', payload: JSON.stringify(session) }]
  }
  const payload = db
    .prepare('SELECT payload FROM main.profile_state_documents WHERE domain = ?')
    .get('workspaceSessionsByHostId')?.payload
  const sessions = typeof payload === 'string' ? parseJson(payload) : {}
  if (!sessions || typeof sessions !== 'object' || Array.isArray(sessions)) {
    throw new Error('Stored remote surface sessions are invalid')
  }
  return [
    {
      domain: 'workspaceSessionsByHostId',
      payload: JSON.stringify({ ...sessions, [hostId]: session })
    }
  ]
}

/** Merge remote partitions once so a later partition cannot overwrite an earlier command. */
export function surfaceSessionBatchReplacements(
  db: Database.Database,
  sessions: ReadonlyMap<string, WorkspaceSessionState>
): { domain: string; payload: string }[] {
  const replacements: { domain: string; payload: string }[] = []
  let remote: Record<string, unknown> | undefined
  for (const [hostId, session] of sessions) {
    if (hostId === 'local') {
      replacements.push({ domain: 'workspaceSession', payload: JSON.stringify(session) })
    } else {
      if (!remote) {
        const row = surfaceSessionReplacements(db, hostId, session)[0]!
        remote = JSON.parse(row.payload)
      }
      remote![hostId] = session
    }
  }
  if (remote) {
    replacements.push({ domain: 'workspaceSessionsByHostId', payload: JSON.stringify(remote) })
  }
  return replacements
}
