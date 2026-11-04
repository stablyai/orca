import type Database from '../sqlite/sync-database'
import { getDefaultWorkspaceSession } from '../../shared/constants'
import { normalizeExecutionHostId } from '../../shared/execution-host'
import type { WorkspaceSessionState } from '../../shared/workspace-session-state-types'
import {
  WORKSPACE_SURFACE_DOMAIN,
  surfaceProfileDomainSchema,
  type SurfaceProfileDomain
} from '../../shared/workspace-surfaces/surface-profile-domain'
import {
  projectSurfaceSession,
  unresolvedSurfaceNativeSessionIds
} from '../../shared/workspace-surfaces/surface-session-projection'
import type { ProfileStateDomainMutation } from '../persistence/profile-state/profile-state-domain-writes'
import { parseJson } from './surface-rows'

/** Presentation saves cannot replace the owner document or undo a committed content command. */
export function protectSurfaceProfileSave(
  db: Database.Database,
  mutations: readonly ProfileStateDomainMutation[],
  committed?: SurfaceProfileDomain
): ProfileStateDomainMutation[] {
  if (
    !committed &&
    !mutations.some((mutation) =>
      ['workspaceSession', 'workspaceSessionsByHostId', WORKSPACE_SURFACE_DOMAIN].includes(
        mutation.domain
      )
    )
  ) {
    return [...mutations]
  }
  const existing = db
    .prepare('SELECT payload FROM main.profile_state_documents WHERE domain = ?')
    .get(WORKSPACE_SURFACE_DOMAIN)
  const domain =
    committed ??
    (existing ? surfaceProfileDomainSchema.parse(parseJson(existing.payload)) : undefined)
  if (!domain) {
    return [...mutations]
  }
  const output = mutations.filter((mutation) => mutation.domain !== WORKSPACE_SURFACE_DOMAIN)
  if (committed) {
    output.push({ domain: WORKSPACE_SURFACE_DOMAIN, payload: JSON.stringify(committed) })
  }
  const domains = new Set(output.map((mutation) => mutation.domain))
  if (committed) {
    if (domain.hosts.local?.terminalInitialized && !domains.has('workspaceSession')) {
      output.push({ domain: 'workspaceSession', payload: readPayload(db, 'workspaceSession') })
    }
    if (
      Object.entries(domain.hosts).some(
        ([id, host]) => id !== 'local' && host.terminalInitialized
      ) &&
      !domains.has('workspaceSessionsByHostId')
    ) {
      output.push({
        domain: 'workspaceSessionsByHostId',
        payload: readPayload(db, 'workspaceSessionsByHostId')
      })
    }
  }
  return output.map((mutation) => {
    if (mutation.domain === 'workspaceSession' && domain.hosts.local?.terminalInitialized) {
      return {
        ...mutation,
        payload: JSON.stringify(project(domain, 'local', sessionValue(mutation.payload)))
      }
    }
    if (
      mutation.domain !== 'workspaceSessionsByHostId' ||
      !Object.entries(domain.hosts).some(([id, host]) => id !== 'local' && host.terminalInitialized)
    ) {
      return mutation
    }
    const sessions: Record<string, WorkspaceSessionState> =
      mutation.payload === null ? {} : JSON.parse(mutation.payload)
    for (const [hostId, host] of Object.entries(domain.hosts)) {
      if (hostId !== 'local' && host.terminalInitialized) {
        sessions[hostId] = project(domain, hostId, sessions[hostId] ?? getDefaultWorkspaceSession())
      }
    }
    return { ...mutation, payload: JSON.stringify(sessions) }
  })
}

function project(
  domain: SurfaceProfileDomain,
  hostId: string,
  session: WorkspaceSessionState
): WorkspaceSessionState {
  const normalized = normalizeExecutionHostId(hostId)
  if (!normalized) {
    throw new Error('Surface profile host identity is invalid')
  }
  const host = domain.hosts[hostId]!
  return projectSurfaceSession(
    normalized,
    session,
    host.surfaces,
    host.chatInitialization === 'verified',
    unresolvedSurfaceNativeSessionIds(host.surfaces, host.chatBaseline?.tabs)
  )
}

function sessionValue(payload: string | null): WorkspaceSessionState {
  return payload === null ? getDefaultWorkspaceSession() : JSON.parse(payload)
}

function readPayload(db: Database.Database, domain: string): string | null {
  const payload = db
    .prepare('SELECT payload FROM main.profile_state_documents WHERE domain = ?')
    .get(domain)?.payload
  return typeof payload === 'string' ? payload : null
}
