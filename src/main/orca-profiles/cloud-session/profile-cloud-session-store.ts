import { rmSync } from 'node:fs'
import type { OrcaCloudSessionPersistence } from '../../../shared/orca-profiles/orca-profiles'
import { inCredentialFileOrder } from '../../credentials/credential-file-io'
import {
  getOrcaCloudSessionPath,
  readOrcaCloudSessionFile,
  writeOrcaCloudSessionFile,
  writeOrcaCloudSessionFileOnShutdown,
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

type SessionWriteEpoch = { sealed: boolean; pending: number; revision: number }
const writeEpochs = new Map<string, SessionWriteEpoch>()

// Disk may hold spent tokens: retry unsaved rotations on reads/quit until saved or superseded.
const unsavedRotations = new Map<
  string,
  { profileId: string; userDataPath: string; session: OrcaCloudSession; epoch: SessionWriteEpoch }
>()

async function writeSession(
  profileId: string,
  userDataPath: string,
  session: OrcaCloudSession,
  epoch: SessionWriteEpoch,
  requireSealed = false
): Promise<OrcaCloudSessionPersistence> {
  const persistence = await writeOrcaCloudSessionFile(
    profileId,
    userDataPath,
    session,
    requireSealed,
    () => !epoch.sealed
  )
  if (!epoch.sealed) {
    rememberMemorySession(orcaCloudSessionKey(profileId, userDataPath), { session, persistence })
  }
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
  const key = orcaCloudSessionKey(profileId, userDataPath)
  let epoch = writeEpochs.get(key)
  if (!epoch || epoch.sealed) {
    epoch = { sealed: false, pending: 0, revision: 0 }
    writeEpochs.set(key, epoch)
  }
  const previousUnsaved = unsavedRotations.get(key)
  const revision = ++epoch.revision
  if (options.spentOnFailure) {
    unsavedRotations.set(key, { profileId, userDataPath, session, epoch })
  } else if (previousUnsaved?.session.refreshToken !== session.refreshToken) {
    unsavedRotations.delete(key)
  }
  const admittedEpoch = epoch
  admittedEpoch.pending++
  return inSessionOrder(profileId, userDataPath, () =>
    saveSession(profileId, userDataPath, session, admittedEpoch, options)
  )
    .catch((error: unknown) => {
      if (
        !admittedEpoch.sealed &&
        admittedEpoch.revision === revision &&
        previousUnsaved &&
        !unsavedRotations.has(key)
      ) {
        unsavedRotations.set(key, previousUnsaved)
      }
      throw error
    })
    .finally(() => {
      admittedEpoch.pending--
      releaseWriteEpoch(key, admittedEpoch)
    })
}
export async function readOrcaCloudSession(
  profileId: string,
  userDataPath: string
): Promise<OrcaCloudSessionReadResult> {
  return inSessionOrder(profileId, userDataPath, () => readSession(profileId, userDataPath))
}
function releaseWriteEpoch(key: string, epoch: SessionWriteEpoch): void {
  if (!epoch.pending && !unsavedRotations.has(key) && writeEpochs.get(key) === epoch) {
    writeEpochs.delete(key)
  }
}

export function discardUnsavedOrcaCloudSession(profileId: string, userDataPath: string): void {
  const key = orcaCloudSessionKey(profileId, userDataPath)
  unsavedRotations.delete(key)
  const epoch = writeEpochs.get(key)
  if (epoch) {
    epoch.sealed = true
    releaseWriteEpoch(key, epoch)
  }
}

export async function clearOrcaCloudSession(
  profileId: string,
  userDataPath: string
): Promise<void> {
  discardUnsavedOrcaCloudSession(profileId, userDataPath)
  const key = orcaCloudSessionKey(profileId, userDataPath)
  const epoch = { sealed: false, pending: 1, revision: 0 }
  writeEpochs.set(key, epoch)
  return inSessionOrder(profileId, userDataPath, async () => {
    if (!epoch.sealed) {
      memorySessions.delete(key)
      rmSync(getOrcaCloudSessionPath(profileId, userDataPath), { force: true })
    }
  }).finally(() => {
    epoch.pending--
    releaseWriteEpoch(key, epoch)
  })
}
async function saveSession(
  profileId: string,
  userDataPath: string,
  session: OrcaCloudSession,
  epoch: SessionWriteEpoch,
  options: { spentOnFailure?: boolean; requireSealed?: boolean }
): Promise<OrcaCloudSessionPersistence> {
  const key = orcaCloudSessionKey(profileId, userDataPath)
  try {
    const persistence = await writeSession(
      profileId,
      userDataPath,
      session,
      epoch,
      options.requireSealed
    )
    if (!epoch.sealed && unsavedRotations.get(key)?.session.refreshToken === session.refreshToken) {
      unsavedRotations.delete(key)
    }
    return persistence
  } catch (error) {
    if (!options.spentOnFailure) {
      throw error
    }
    // Losing rotated tokens would replay spent disk tokens and risk revoking the family.
    if (!epoch.sealed && unsavedRotations.get(key)?.session === session) {
      try {
        rmSync(getOrcaCloudSessionPath(profileId, userDataPath), { force: true })
      } catch {
        // A spent token left on disk costs one sign-in after restart, never a loop.
      }
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
    await writeSession(unsaved.profileId, unsaved.userDataPath, unsaved.session, unsaved.epoch)
    if (!unsaved.epoch.sealed && unsavedRotations.get(key) === unsaved) {
      unsavedRotations.delete(key)
    }
    releaseWriteEpoch(key, unsaved.epoch)
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

// Seal admitted writers before the synchronous handoff; even busy profiles must recover.
export function flushUnsavedOrcaCloudSessionsOnShutdown(): void {
  for (const [key, unsaved] of unsavedRotations) {
    unsaved.epoch.sealed = true
    try {
      const persistence = writeOrcaCloudSessionFileOnShutdown(
        unsaved.profileId,
        unsaved.userDataPath,
        unsaved.session
      )
      rememberMemorySession(key, { session: unsaved.session, persistence })
      unsavedRotations.delete(key)
      releaseWriteEpoch(key, unsaved.epoch)
    } catch {
      // Best effort: the OS will not wait for an asynchronous retry.
    }
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

export function getOrcaCloudMemorySessionCountForTests(): number {
  return memorySessions.size
}
