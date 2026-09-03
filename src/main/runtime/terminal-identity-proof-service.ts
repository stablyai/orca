import { parseExecutionHostId, type ExecutionHostId } from '../../shared/execution-host'
import type {
  RuntimeTerminalIdentityProofBegin,
  RuntimeTerminalIdentityProofComplete,
  RuntimeTerminalListResult,
  RuntimeTerminalSummary
} from '../../shared/runtime-terminal-contracts'
import {
  resolveTerminalIdentityProofMatch,
  TerminalIdentityProofLedger,
  type TerminalIdentityProofCandidate,
  type TerminalIdentityProofChallenge,
  type TerminalIdentityProofDelta
} from './terminal-identity-proof-ledger'

export const TERMINAL_IDENTITY_PROOF_MAX_CANDIDATES = 64
export const TERMINAL_IDENTITY_PROOF_LIST_LIMIT = 1000

export type TerminalIdentityProofLeafObservation = Readonly<{
  tabId: string
  leafId: string
  ptyId: string | null
  connected: boolean
}>

export function isSoleLiveTerminalLeafInTab(
  candidate: Pick<TerminalIdentityProofCandidate, 'tabId' | 'leafId' | 'ptyId'>,
  leaves: Iterable<TerminalIdentityProofLeafObservation>
): boolean {
  const liveLeaves = [...leaves].filter(
    (leaf) => leaf.tabId === candidate.tabId && leaf.connected && leaf.ptyId !== null
  )
  return (
    liveLeaves.length === 1 &&
    liveLeaves[0].leafId === candidate.leafId &&
    liveLeaves[0].ptyId === candidate.ptyId
  )
}

export type TerminalIdentityProofHost = Readonly<{
  runtimeId: string
  resolveWorktreeId: (selector: string) => Promise<string>
  listTerminals: (worktreeId: string) => Promise<RuntimeTerminalListResult>
  getWorkspaceExecutionHostId: (worktreeId: string) => ExecutionHostId | null | undefined
  getTopologyRevision: (worktreeId: string) => number
  isCandidateEligible: (worktreeId: string, terminal: RuntimeTerminalSummary) => boolean
  captureCandidate: (
    worktreeId: string,
    executionHostId: ExecutionHostId,
    terminal: RuntimeTerminalSummary
  ) => TerminalIdentityProofCandidate | null
  isCandidateCurrent: (worktreeId: string, candidate: TerminalIdentityProofCandidate) => boolean
  readDelta: (
    candidate: TerminalIdentityProofCandidate
  ) => Promise<TerminalIdentityProofDelta | null>
  listCurrentNames: (worktreeId: string, exceptPtyId: string) => readonly (string | null)[]
  renameCandidate: (
    challenge: TerminalIdentityProofChallenge,
    candidate: TerminalIdentityProofCandidate,
    title: string
  ) => RuntimeTerminalIdentityProofComplete
}>

export class TerminalIdentityProofService {
  private readonly ledger = new TerminalIdentityProofLedger()

  constructor(private readonly host: TerminalIdentityProofHost) {}

  async begin(
    worktreeSelector: string,
    callerFingerprint?: string
  ): Promise<RuntimeTerminalIdentityProofBegin> {
    const worktreeId = await this.host.resolveWorktreeId(worktreeSelector)
    const listed = await this.host.listTerminals(worktreeId)
    const { executionHostId, topologyRevision } = this.requireAuthoritativeScope(worktreeId, listed)
    const eligible = listed.terminals.filter(
      (terminal) =>
        isUsableTerminal(terminal) &&
        terminal.executionHostId === executionHostId &&
        this.host.isCandidateEligible(worktreeId, terminal)
    )
    if (eligible.length === 0) {
      throw new Error('terminal_identity_proof_not_found')
    }
    if (eligible.length > TERMINAL_IDENTITY_PROOF_MAX_CANDIDATES) {
      throw new Error('terminal_identity_proof_capacity')
    }
    const candidates = eligible.map((terminal) =>
      this.host.captureCandidate(worktreeId, executionHostId, terminal)
    )
    if (candidates.some((candidate) => candidate === null)) {
      throw new Error('terminal_identity_proof_unverifiable')
    }
    const captured = candidates.filter(
      (candidate): candidate is TerminalIdentityProofCandidate => candidate !== null
    )
    const challenge = this.ledger.issue({
      runtimeId: this.host.runtimeId,
      worktreeId,
      executionHostId,
      topologyRevision,
      callerFingerprint,
      candidates: captured
    })
    return publicChallenge(challenge)
  }

  async complete(
    challengeId: string,
    requestedTitle: string,
    callerFingerprint?: string
  ): Promise<RuntimeTerminalIdentityProofComplete> {
    const title = normalizeTerminalIdentityProofTitle(requestedTitle)
    const challenge = this.ledger.claim(challengeId)
    if (
      challenge.runtimeId !== this.host.runtimeId ||
      (challenge.callerFingerprint !== undefined &&
        challenge.callerFingerprint !== callerFingerprint)
    ) {
      throw new Error('terminal_identity_proof_identity_changed')
    }
    const listed = await this.host.listTerminals(challenge.worktreeId)
    const scope = this.requireAuthoritativeScope(challenge.worktreeId, listed)
    if (
      scope.executionHostId !== challenge.executionHostId ||
      scope.topologyRevision !== challenge.topologyRevision
    ) {
      throw new Error('terminal_identity_proof_identity_changed')
    }
    for (const candidate of challenge.candidates) {
      if (
        !listed.terminals.some((terminal) =>
          terminalMatchesCandidate(terminal, challenge.executionHostId, candidate)
        ) ||
        !this.host.isCandidateCurrent(challenge.worktreeId, candidate)
      ) {
        throw new Error('terminal_identity_proof_identity_changed')
      }
    }
    const deltaEntries = await Promise.all(
      challenge.candidates.map(async (candidate) => {
        const delta = await this.host.readDelta(candidate)
        return delta ? ([candidate.ptyId, delta] as const) : null
      })
    )
    if (deltaEntries.some((entry) => entry === null)) {
      throw new Error('terminal_identity_proof_unverifiable')
    }
    const deltas = new Map(
      deltaEntries.filter(
        (entry): entry is readonly [string, TerminalIdentityProofDelta] => entry !== null
      )
    )
    if (
      this.host.getWorkspaceExecutionHostId(challenge.worktreeId) !== challenge.executionHostId ||
      this.host.getTopologyRevision(challenge.worktreeId) !== challenge.topologyRevision ||
      challenge.candidates.some(
        (candidate) => !this.host.isCandidateCurrent(challenge.worktreeId, candidate)
      )
    ) {
      throw new Error('terminal_identity_proof_identity_changed')
    }
    const matched = resolveTerminalIdentityProofMatch(challenge, deltas)
    this.requireAtomicRenameAllowed(challenge, matched, title)
    return this.host.renameCandidate(challenge, matched, title)
  }

  private requireAuthoritativeScope(
    worktreeId: string,
    listed: RuntimeTerminalListResult
  ): { executionHostId: ExecutionHostId; topologyRevision: number } {
    const executionHostId = this.host.getWorkspaceExecutionHostId(worktreeId)
    const topologyRevision = listed.topologyRevisions?.[worktreeId]
    const hostIds = listed.hostScope?.hostIds
    const omittedHostIds = listed.hostScope?.omittedHostIds
    if (
      listed.truncated ||
      topologyRevision === undefined ||
      !executionHostId ||
      parseExecutionHostId(executionHostId)?.kind === 'runtime' ||
      !Array.isArray(hostIds) ||
      !Array.isArray(omittedHostIds) ||
      !hostIds.includes(executionHostId) ||
      omittedHostIds.length !== 0
    ) {
      throw new Error('terminal_identity_proof_unverifiable')
    }
    return { executionHostId, topologyRevision }
  }

  private requireAtomicRenameAllowed(
    challenge: TerminalIdentityProofChallenge,
    candidate: TerminalIdentityProofCandidate,
    title: string
  ): void {
    if (!this.host.isCandidateCurrent(challenge.worktreeId, candidate)) {
      throw new Error('terminal_identity_proof_identity_changed')
    }
    if (this.host.listCurrentNames(challenge.worktreeId, candidate.ptyId).includes(title)) {
      throw new Error('terminal_identity_proof_name_conflict')
    }
    if (!this.host.isCandidateCurrent(challenge.worktreeId, candidate)) {
      throw new Error('terminal_identity_proof_identity_changed')
    }
  }
}

function isUsableTerminal(terminal: RuntimeTerminalSummary): boolean {
  return (
    terminal.connected && terminal.writable && terminal.orphaned !== true && terminal.ptyId !== null
  )
}

function terminalMatchesCandidate(
  terminal: RuntimeTerminalSummary,
  executionHostId: ExecutionHostId,
  candidate: TerminalIdentityProofCandidate
): boolean {
  return (
    isUsableTerminal(terminal) &&
    terminal.handle === candidate.handle &&
    terminal.ptyId === candidate.ptyId &&
    terminal.incarnationId === candidate.incarnationId &&
    terminal.tabId === candidate.tabId &&
    terminal.leafId === candidate.leafId &&
    terminal.executionHostId === executionHostId
  )
}

function publicChallenge(
  challenge: TerminalIdentityProofChallenge
): RuntimeTerminalIdentityProofBegin {
  return {
    challengeId: challenge.challengeId,
    marker: challenge.marker,
    expiresAt: challenge.expiresAt,
    worktreeId: challenge.worktreeId,
    executionHostId: challenge.executionHostId
  }
}

function normalizeTerminalIdentityProofTitle(value: string): string {
  const title = value.trim()
  if (!title || title.length > 120 || [...title].some(isControlCharacter)) {
    throw new Error('terminal_identity_proof_invalid_name')
  }
  return title
}

function isControlCharacter(value: string): boolean {
  const codePoint = value.codePointAt(0) ?? 0
  return codePoint <= 0x1f || (codePoint >= 0x7f && codePoint <= 0x9f)
}
