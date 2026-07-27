import {
  normalize as normalizePosixPath,
  basename as basenamePosix,
  dirname as dirnamePosix
} from 'node:path/posix'
import type { AiVaultSession } from '../../shared/ai-vault-types'
import { sessionSortTime } from './session-scanner-accumulator'
import { splitHermesSqliteCandidate } from './session-scanner-hermes-sqlite-paths'
import type { SessionFileCandidate } from './session-scanner-types'

export function dedupeSessions(sessions: AiVaultSession[]): AiVaultSession[] {
  const byIdentity = new Map<string, AiVaultSession>()
  for (const session of sessions) {
    const hermesIdentity = hermesSessionIdentity(session)
    // Why: recognized Hermes stores dedupe by store/profile/session. An anomalous
    // Hermes path needs filePath as a last-resort discriminator; other agents
    // retain their established profile/session identity.
    const key = hermesIdentity
      ? `${session.executionHostId}\u0000${session.agent}\u0000${hermesIdentity}`
      : session.agent === 'hermes'
        ? `${session.executionHostId}\u0000${session.agent}\u0000${session.profileName ?? ''}\u0000${session.sessionId}\u0000${session.filePath}`
        : `${session.executionHostId}\u0000${session.agent}\u0000${session.profileName ?? ''}\u0000${session.sessionId}`
    const previous = byIdentity.get(key)
    if (!previous || shouldPreferSession(session, previous)) {
      byIdentity.set(key, session)
    }
  }
  return [...byIdentity.values()]
}

export function canonicalizeCandidates(candidates: SessionFileCandidate[]): SessionFileCandidate[] {
  const byIdentity = new Map<string, SessionFileCandidate>()
  const result: SessionFileCandidate[] = []
  for (const candidate of candidates) {
    if (candidate.agent !== 'hermes') {
      result.push(candidate)
      continue
    }
    const identity = hermesCandidateIdentity(candidate)
    if (!identity) {
      result.push(candidate)
      continue
    }
    const previous = byIdentity.get(identity)
    if (!previous || isHermesSqliteCandidate(candidate)) {
      byIdentity.set(identity, candidate)
    }
  }
  result.push(...byIdentity.values())
  return result
}

function hermesCandidateIdentity(candidate: SessionFileCandidate): string | null {
  const storeRoot = hermesStoreRoot(candidate.file.path)
  if (!storeRoot) {
    return null
  }
  const sqlite = splitHermesSqliteCandidate(candidate.file.path)
  const sessionId = sqlite?.sessionId ?? hermesLegacySessionId(candidate.file.path)
  return sessionId
    ? `${storeRoot}\u0000${candidate.profileName ?? 'default'}\u0000${sessionId}`
    : null
}

function hermesSessionIdentity(session: AiVaultSession): string | null {
  if (session.agent !== 'hermes') {
    return null
  }
  const storeRoot = hermesStoreRoot(session.filePath, session.storage)
  return storeRoot
    ? `${storeRoot}\u0000${session.profileName ?? 'default'}\u0000${session.sessionId}`
    : null
}

function hermesStoreRoot(filePath: string, storage?: AiVaultSession['storage']): string | null {
  const sqlite = splitHermesSqliteCandidate(filePath)
  if (sqlite) {
    return normalizeHermesPath(dirnamePosix(normalizeHermesPath(sqlite.dbPath)))
  }
  const normalizedPath = normalizeHermesPath(filePath)
  if (storage === 'sqlite' && basenamePosix(normalizedPath).toLowerCase() === 'state.db') {
    return normalizeHermesPath(dirnamePosix(normalizedPath))
  }
  if (!/^session_.+\.json$/i.test(basenamePosix(normalizedPath))) {
    return null
  }
  const sessionsDir = dirnamePosix(normalizedPath)
  if (basenamePosix(sessionsDir).toLowerCase() !== 'sessions') {
    return null
  }
  return normalizeHermesPath(dirnamePosix(sessionsDir))
}

function hermesLegacySessionId(filePath: string): string | null {
  const pathWithPosixSeparators = filePath.replaceAll(String.fromCharCode(92), '/')
  const match = basenamePosix(pathWithPosixSeparators).match(/^session_(.+)\.json$/i)
  return match?.[1] || null
}

function normalizeHermesPath(filePath: string): string {
  const normalized = normalizePosixPath(filePath.replaceAll(String.fromCharCode(92), '/'))
  let withoutTrailingSlash = normalized
  while (withoutTrailingSlash.length > 1 && withoutTrailingSlash.endsWith('/')) {
    withoutTrailingSlash = withoutTrailingSlash.slice(0, -1)
  }
  return withoutTrailingSlash.length >= 2 && withoutTrailingSlash[1] === ':'
    ? withoutTrailingSlash.toLowerCase()
    : withoutTrailingSlash
}

function isHermesSqliteCandidate(candidate: SessionFileCandidate): boolean {
  return splitHermesSqliteCandidate(candidate.file.path) !== null
}

function shouldPreferSession(candidate: AiVaultSession, previous: AiVaultSession): boolean {
  if (candidate.storage === 'sqlite' && previous.storage !== 'sqlite') {
    return true
  }
  if (candidate.storage !== 'sqlite' && previous.storage === 'sqlite') {
    return false
  }
  return sessionSortTime(candidate) > sessionSortTime(previous)
}
