import type { AiVaultSession } from '../../shared/ai-vault-types'
import {
  codexRevertContinuationBeats,
  codexRevertIdentityKey,
  codexRevertPeers,
  codexSessionAliasAdmission,
  codexSessionAliasBeats,
  isCodexRevertContinuationPath
} from './codex-session-root-dedup'
import { sessionSortTime } from './session-scanner-accumulator'

function sessionAliasKey(session: AiVaultSession): string | null {
  return sessionAliasAdmission(session)?.key ?? null
}

function sessionAliasAdmission(session: AiVaultSession): {
  key: string
  revertContinuation: boolean
  revertIdentity: string | null
} | null {
  if (session.agent !== 'devin') {
    const codex = codexSessionAliasAdmission(session)
    if (!codex) {
      return null
    }
    return {
      key: `codex\0${codex.key}`,
      revertContinuation: codex.revertContinuation,
      revertIdentity: codex.revertIdentity
    }
  }
  // Sibling exports share an index; different installs and WSL distros do not.
  const cliDir = session.filePath.split(/[\\/]/).slice(0, -2).join('/')
  return {
    key: `devin\0${session.executionHostId}\0${cliDir}\0${session.sessionId}`,
    revertContinuation: false,
    revertIdentity: null
  }
}

function sessionAliasBeats(candidate: AiVaultSession, best: AiVaultSession): boolean {
  if (candidate.agent !== 'devin') {
    return codexSessionAliasBeats(candidate, best)
  }
  const candidateTime = sessionSortTime(candidate)
  const bestTime = sessionSortTime(best)
  if (candidateTime !== bestTime) {
    return candidateTime > bestTime
  }
  // The database can give both exports the same activity time.
  if (candidate.modifiedAt !== best.modifiedAt) {
    return Date.parse(candidate.modifiedAt) > Date.parse(best.modifiedAt)
  }
  const candidateCurrent = candidate.filePath.split(/[\\/]/).at(-2) === 'agent_logs'
  const bestCurrent = best.filePath.split(/[\\/]/).at(-2) === 'agent_logs'
  if (candidateCurrent !== bestCurrent) {
    return candidateCurrent
  }
  return candidate.filePath < best.filePath
}

export function dedupeScannedSessions(sessions: readonly AiVaultSession[]): AiVaultSession[] {
  const bestByKey = new Map<string, AiVaultSession>()
  for (const session of sessions) {
    const key = sessionAliasKey(session)
    if (!key) {
      continue
    }
    const best = bestByKey.get(key)
    if (!best || sessionAliasBeats(session, best)) {
      bestByKey.set(key, session)
    }
  }
  // Why: Esc-revert keeps the original rollout and writes a `_suffix` continuation with the same session id (#24053).
  const revertWinnerByIdentity = new Map<string, AiVaultSession>()
  const revertGroups = new Map<string, AiVaultSession[]>()
  for (const session of bestByKey.values()) {
    const identity = codexRevertIdentityKey(session)
    if (!identity) {
      continue
    }
    const group = revertGroups.get(identity)
    if (group) {
      group.push(session)
    } else {
      revertGroups.set(identity, [session])
    }
  }
  for (const [identity, group] of revertGroups) {
    if (
      group.length < 2 ||
      !group.some((session) => isCodexRevertContinuationPath(session.filePath, session.sessionId))
    ) {
      continue
    }
    let best = group[0]
    for (const candidate of group.slice(1)) {
      if (codexRevertContinuationBeats(candidate, best)) {
        best = candidate
      }
    }
    revertWinnerByIdentity.set(identity, best)
  }
  return sessions.filter((session) => {
    const key = sessionAliasKey(session)
    if (!key) {
      return true
    }
    if (bestByKey.get(key) !== session) {
      return false
    }
    const identity = codexRevertIdentityKey(session)
    const revertWinner = identity ? revertWinnerByIdentity.get(identity) : undefined
    return !revertWinner || revertWinner === session
  })
}

type SessionWinner = { session: AiVaultSession; indices: number | number[] }

/** Scan-local accumulation; parsed rows must not be mutated after admission. */
export class ScannedSessionCollection {
  private readonly sessions = new Map<number, AiVaultSession>()
  // Keyed by the row's own sessionId string, so an unlimited scan retains no
  // alias key per live row; a per-alias-key map appears only for the rare id
  // that spans several hosts, namespaces, or rollout names.
  private readonly winnersBySessionId = new Map<
    string,
    SessionWinner | Map<string, SessionWinner>
  >()
  // Identities that already have an Esc-revert continuation. Absent means differently named rollouts stay untouched.
  private readonly revertIdentities = new Set<string>()
  private nextIndex = 0

  get size(): number {
    return this.sessions.size
  }

  values(): IterableIterator<AiVaultSession> {
    return this.sessions.values()
  }

  add(session: AiVaultSession): void {
    const admission = sessionAliasAdmission(session)
    const index = this.nextIndex++
    if (admission && !this.admit(session, admission.key, index)) {
      return
    }
    if (admission?.revertContinuation && admission.revertIdentity) {
      this.revertIdentities.add(admission.revertIdentity)
    }
    this.sessions.set(index, session)
  }

  /** Whether the row is retained; a losing alias is dropped. */
  private admit(session: AiVaultSession, key: string, index: number): boolean {
    const bucket = this.winnersBySessionId.get(session.sessionId)
    if (bucket instanceof Map) {
      return this.admitIntoAliasMap(bucket, session, key, index)
    }
    const bucketKey = bucket && sessionAliasKey(bucket.session)
    if (bucket && bucketKey && bucketKey !== key) {
      if (this.shouldContestRevert(bucket.session, session)) {
        const winner = this.contest(bucket, session, index, codexRevertContinuationBeats)
        if (winner) {
          this.winnersBySessionId.set(session.sessionId, winner)
          this.noteRevertContinuation(winner.session)
        }
        return winner?.session === session
      }
      this.winnersBySessionId.set(
        session.sessionId,
        new Map([
          [bucketKey, bucket],
          [key, { session, indices: index }]
        ])
      )
      return true
    }
    const winner = this.contest(bucket, session, index)
    if (winner) {
      this.winnersBySessionId.set(session.sessionId, winner)
    }
    return winner !== null
  }

  /** Different rollout names stay unless one is an Esc-revert continuation of the same session. */
  private admitIntoAliasMap(
    bucket: Map<string, SessionWinner>,
    session: AiVaultSession,
    key: string,
    index: number
  ): boolean {
    const contestants: { key: string; winner: SessionWinner }[] = []
    const sameKey = bucket.get(key)
    if (sameKey) {
      contestants.push({ key, winner: sameKey })
    }
    if (this.shouldScanRevertPeers(session)) {
      for (const [peerKey, winner] of bucket) {
        if (peerKey !== key && codexRevertPeers(winner.session, session)) {
          contestants.push({ key: peerKey, winner })
        }
      }
    }
    if (contestants.length === 0) {
      bucket.set(key, { session, indices: index })
      return true
    }

    let bestSession = session
    let bestKey = key
    let bestWinner: SessionWinner | null = null
    const losers: { key: string; winner: SessionWinner }[] = []
    for (const contestant of contestants) {
      if (contestant.winner.session === session) {
        if (!bestWinner) {
          bestWinner = contestant.winner
          bestKey = contestant.key
        }
        continue
      }
      const incomingWins =
        contestant.key === bestKey
          ? sessionAliasBeats(bestSession, contestant.winner.session)
          : codexRevertContinuationBeats(bestSession, contestant.winner.session)
      if (incomingWins) {
        losers.push(contestant)
        continue
      }
      if (bestWinner) {
        losers.push({ key: bestKey, winner: bestWinner })
      }
      bestSession = contestant.winner.session
      bestKey = contestant.key
      bestWinner = contestant.winner
    }
    for (const loser of losers) {
      this.dropWinner(loser.winner)
      bucket.delete(loser.key)
    }
    if (bestSession !== session) {
      return false
    }
    if (bestWinner?.session === session) {
      if (typeof bestWinner.indices === 'number') {
        bestWinner.indices = [bestWinner.indices, index]
      } else {
        bestWinner.indices.push(index)
      }
      this.noteRevertContinuation(session)
      return true
    }
    bucket.set(key, { session, indices: index })
    this.noteRevertContinuation(session)
    return true
  }

  /** Differently named rollouts are scanned only after a revert continuation for that identity exists. */
  private shouldScanRevertPeers(session: AiVaultSession): boolean {
    if (isCodexRevertContinuationPath(session.filePath, session.sessionId)) {
      return true
    }
    const identity = codexRevertIdentityKey(session)
    return identity !== null && this.revertIdentities.has(identity)
  }

  private shouldContestRevert(existing: AiVaultSession, incoming: AiVaultSession): boolean {
    if (
      !isCodexRevertContinuationPath(incoming.filePath, incoming.sessionId) &&
      !isCodexRevertContinuationPath(existing.filePath, existing.sessionId)
    ) {
      return false
    }
    return codexRevertPeers(existing, incoming)
  }

  private noteRevertContinuation(session: AiVaultSession): void {
    if (!isCodexRevertContinuationPath(session.filePath, session.sessionId)) {
      return
    }
    const identity = codexRevertIdentityKey(session)
    if (identity) {
      this.revertIdentities.add(identity)
    }
  }

  private dropWinner(winner: SessionWinner): void {
    if (typeof winner.indices === 'number') {
      this.sessions.delete(winner.indices)
      return
    }
    for (const previousIndex of winner.indices) {
      this.sessions.delete(previousIndex)
    }
  }

  /** The alias key's winner after this row, or null when the row loses. */
  private contest(
    best: SessionWinner | undefined,
    session: AiVaultSession,
    index: number,
    beats: (candidate: AiVaultSession, current: AiVaultSession) => boolean = sessionAliasBeats
  ): SessionWinner | null {
    if (!best) {
      return { session, indices: index }
    }
    if (best.session === session) {
      // The batch filter retains every occurrence of the winning object.
      if (typeof best.indices === 'number') {
        best.indices = [best.indices, index]
      } else {
        best.indices.push(index)
      }
      return best
    }
    if (!beats(session, best.session)) {
      return null
    }
    this.dropWinner(best)
    return { session, indices: index }
  }
}
