import { rm } from 'node:fs/promises'
import type { OrcaCloudSessionPersistence } from '../../../shared/orca-profiles/orca-profiles'
import { inCredentialFileOrder } from '../../credentials/credential-file-io'
import {
  getOrcaCloudSessionPath,
  readOrcaCloudSessionFile,
  writeOrcaCloudSessionFile,
  type OrcaCloudSession,
  type OrcaCloudSessionReadResult
} from './profile-cloud-session-file'
export { getOrcaCloudSessionPath } from './profile-cloud-session-file'
export type {
  OrcaCloudSession,
  OrcaCloudSessionIdentity,
  OrcaCloudSessionReadResult
} from './profile-cloud-session-file'

type CachedOrcaCloudSession = {
  session: OrcaCloudSession
  persistence: Exclude<OrcaCloudSessionPersistence, 'none'>
}

const memorySessions = new Map<string, CachedOrcaCloudSession>()
export const MAX_MEMORY_CLOUD_SESSIONS = 64

function rememberMemorySession(key: string, session: CachedOrcaCloudSession): void {
  memorySessions.delete(key)
  memorySessions.set(key, session)
  while (memorySessions.size > MAX_MEMORY_CLOUD_SESSIONS) {
    const oldest = memorySessions.keys().next()
    if (oldest.done || oldest.value === key) {
      break
    }
    memorySessions.delete(oldest.value)
  }
}

export function orcaCloudSessionKey(profileId: string, userDataPath: string): string {
  return `${userDataPath}\0${profileId}`
}

// Disk may hold spent tokens: retry unsaved rotations on reads/quit until saved or superseded.
const unsavedRotations = new Map<
  string,
  { profileId: string; userDataPath: string; session: OrcaCloudSession }
>()

async function writeSession(
  profileId: string,
  userDataPath: string,
  session: OrcaCloudSession,
  requireSealed = false
): Promise<OrcaCloudSessionPersistence> {
  const persistence = await writeOrcaCloudSessionFile(
    profileId,
    userDataPath,
    session,
    requireSealed
  )
  rememberMemorySession(orcaCloudSessionKey(profileId, userDataPath), {
    session,
    persistence: persistence as Exclude<OrcaCloudSessionPersistence, 'none'>
  })
  return persistence
}

const pendingSessions = new Set<Promise<unknown>>()
function inSessionOrder<T>(
  profileId: string,
  userDataPath: string,
  run: () => Promise<T>
): Promise<T> {
  const next = inCredentialFileOrder(getOrcaCloudSessionPath(profileId, userDataPath), run)
  pendingSessions.add(next)
  void next.then(
    () => pendingSessions.delete(next),
    () => pendingSessions.delete(next)
  )
  return next
}

export async function saveOrcaCloudSession(
  profileId: string,
  userDataPath: string,
  session: OrcaCloudSession,
  options: { spentOnFailure?: boolean; requireSealed?: boolean } = {}
): Promise<OrcaCloudSessionPersistence> {
  return inSessionOrder(profileId, userDataPath, () =>
    saveSession(profileId, userDataPath, session, options)
  )
}
export async function readOrcaCloudSession(
  profileId: string,
  userDataPath: string
): Promise<OrcaCloudSessionReadResult> {
  return inSessionOrder(profileId, userDataPath, () => readSession(profileId, userDataPath))
}
export async function clearOrcaCloudSession(
  profileId: string,
  userDataPath: string
): Promise<void> {
  return inSessionOrder(profileId, userDataPath, () => clearSession(profileId, userDataPath))
}
async function saveSession(
  profileId: string,
  userDataPath: string,
  session: OrcaCloudSession,
  options: { spentOnFailure?: boolean; requireSealed?: boolean } = {}
): Promise<OrcaCloudSessionPersistence> {
  const key = orcaCloudSessionKey(profileId, userDataPath)
  try {
    const persistence = await writeSession(profileId, userDataPath, session, options.requireSealed)
    unsavedRotations.delete(key)
    return persistence
  } catch (error) {
    if (!options.spentOnFailure) {
      throw error
    }
    // Losing rotated tokens would replay spent disk tokens and risk revoking the family.
    unsavedRotations.set(key, { profileId, userDataPath, session })
    try {
      await rm(getOrcaCloudSessionPath(profileId, userDataPath), { force: true })
    } catch {
      // A spent token left on disk costs one sign-in after restart, never a loop.
    }
    return 'memory-only'
  }
}

async function retryUnsavedRotation(key: string): Promise<void> {
  const unsaved = unsavedRotations.get(key)
  if (!unsaved) {
    return
  }
  try {
    await writeSession(unsaved.profileId, unsaved.userDataPath, unsaved.session)
    unsavedRotations.delete(key)
  } catch {
    // Retry unsaved rotation on the next read or quit flush.
  }
}

export async function flushUnsavedOrcaCloudSessions(): Promise<void> {
  while (pendingSessions.size > 0) {
    await Promise.allSettled(pendingSessions)
  }
  for (const [key, unsaved] of unsavedRotations) {
    await inSessionOrder(unsaved.profileId, unsaved.userDataPath, () => retryUnsavedRotation(key))
  }
}

async function readSession(
  profileId: string,
  userDataPath: string
): Promise<OrcaCloudSessionReadResult> {
  const cacheKey = orcaCloudSessionKey(profileId, userDataPath)
  await retryUnsavedRotation(cacheKey)
  const unsaved = unsavedRotations.get(cacheKey)
  if (unsaved) {
    return { status: 'found', session: unsaved.session, persistence: 'memory-only' }
  }
  const memorySession = memorySessions.get(cacheKey)
  if (memorySession) {
    memorySessions.delete(cacheKey)
    memorySessions.set(cacheKey, memorySession)
    return {
      status: 'found',
      session: memorySession.session,
      persistence: memorySession.persistence
    }
  }

  const result = await readOrcaCloudSessionFile(profileId, userDataPath)
  if (result.status === 'found') {
    rememberMemorySession(cacheKey, result)
  }
  return result
}

async function clearSession(profileId: string, userDataPath: string): Promise<void> {
  const key = orcaCloudSessionKey(profileId, userDataPath)
  unsavedRotations.delete(key)
  memorySessions.delete(key)
  await rm(getOrcaCloudSessionPath(profileId, userDataPath), { force: true })
}

export function getOrcaCloudMemorySessionCountForTests(): number {
  return memorySessions.size
}
