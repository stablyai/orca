import type { OrcaCloudCapabilities } from '../../../shared/orca-profiles/orca-cloud-capabilities'
import {
  getTeamCapabilitiesForOrg,
  type OrcaCloudTeamFeatureFlag
} from '../../../shared/orca-profiles/orca-cloud-team-policy'
import type { OrcaProfileSummary } from '../../../shared/orca-profiles/orca-profiles'
import type { OrcaCloudSession } from '../cloud-session/profile-cloud-session-store'
import { sessionBelongsToProfile } from '../cloud-session/profile-cloud-session-identity'

type ActiveTeamProfile = {
  root: string
  profile: OrcaProfileSummary
  session: Pick<OrcaCloudSession, 'identity' | 'capabilities'> | undefined
  sessionRevision: number
}

let active: ActiveTeamProfile | undefined
let queued = false
const listeners = new Set<() => void>()

export function getActiveTeamCapabilities(): OrcaCloudCapabilities | undefined {
  const cloud = active?.profile.cloud
  const session = active?.session
  if (!cloud?.activeOrgId || !session || !sessionBelongsToProfile(session, cloud)) {
    return undefined
  }
  return getTeamCapabilitiesForOrg(session.capabilities, cloud.activeOrgId)
}

export function initializeActiveTeamProfile(
  root: string,
  profile: OrcaProfileSummary
): (session: OrcaCloudSession | undefined) => void {
  const candidate: ActiveTeamProfile = { root, profile, session: undefined, sessionRevision: 0 }
  active = candidate
  return (session) => {
    if (active === candidate && candidate.sessionRevision === 0) {
      observeActiveTeamSession(root, profile.id, session)
    }
  }
}

export function observeActiveTeamProfile(root: string, profile: OrcaProfileSummary): void {
  if (active?.root !== root) {
    return
  }
  if (active.profile.id !== profile.id) {
    active = { root, profile, session: undefined, sessionRevision: 0 }
  } else {
    active.profile = profile
  }
  notify()
}

export function observeActiveTeamSession(
  root: string,
  profileId: string,
  session: OrcaCloudSession | undefined
): void {
  if (active?.root !== root || active.profile.id !== profileId) {
    return
  }
  active.session = session
    ? { identity: session.identity, capabilities: session.capabilities }
    : undefined
  active.sessionRevision++
  notify()
}

function notify(): void {
  if (queued || listeners.size === 0) {
    return
  }
  queued = true
  queueMicrotask(() => {
    queued = false
    for (const listener of listeners) {
      listener()
    }
  })
}

export function onTeamCapabilitiesInvalidated(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

export function isTeamFeatureBlocked(flag: OrcaCloudTeamFeatureFlag): boolean {
  return getActiveTeamCapabilities()?.flags[flag] === false
}

export function onTeamFeatureBlockChanged(
  flag: OrcaCloudTeamFeatureFlag,
  listener: (blocked: boolean) => void
): () => void {
  let blocked = isTeamFeatureBlocked(flag)
  return onTeamCapabilitiesInvalidated(() => {
    const next = isTeamFeatureBlocked(flag)
    if (next !== blocked) {
      blocked = next
      listener(blocked)
    }
  })
}
