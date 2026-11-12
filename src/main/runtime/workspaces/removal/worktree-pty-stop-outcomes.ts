import type { PtyShutdownEvidence } from '../../../providers/pty-provider-contract'
import { isCurrentPtyExit } from '../../../ipc/pty/provider/ownership-state'
import type { WorktreeTerminalStopSnapshot } from '../../terminal/stop/worktree-terminal-stop-options'
import type { WorktreePtyStopOutcome, WorktreeTeardownRuntime } from './worktree-teardown-contract'
import { clearStoppedPtyState } from './worktree-pty-surface-sweeps'
import { settleBeforeDeadline } from './settle-before-deadline'
import type { PtyProcessInfo } from '../../../providers/pty-process-info'

type FinalProviderIdentity = Pick<PtyProcessInfo, 'incarnationId' | 'worktreeId'> & {
  ambiguous: boolean
}

export type FinalPtyStopProviderEvidence = {
  worktreeId: string
  identities: ReadonlyMap<string, FinalProviderIdentity>
}

export function indexFinalPtyStopProviderIdentities(
  rows: readonly PtyProcessInfo[]
): ReadonlyMap<string, FinalProviderIdentity> {
  const identities = new Map<string, FinalProviderIdentity>()
  for (const row of rows) {
    const prior = identities.get(row.id)
    identities.set(row.id, {
      incarnationId: row.incarnationId,
      worktreeId: row.worktreeId,
      ambiguous:
        !row.incarnationId ||
        Boolean(
          prior &&
          (prior.ambiguous ||
            prior.incarnationId !== row.incarnationId ||
            prior.worktreeId !== row.worktreeId)
        )
    })
  }
  return identities
}

export function capturePtyStopOutcomes(
  identities: Iterable<readonly [string, string | undefined]>,
  runtime: WorktreeTeardownRuntime,
  unsubscribe: (() => void)[]
): Map<string, WorktreePtyStopOutcome> {
  const outcomes = new Map<string, WorktreePtyStopOutcome>()
  for (const [id, incarnationId] of identities) {
    const prior = outcomes.get(id)
    if (prior) {
      if (incarnationId && prior.incarnationId && incarnationId !== prior.incarnationId) {
        prior.conflict = true
      } else {
        prior.incarnationId ??= incarnationId
      }
    } else {
      outcomes.set(id, { incarnationId, attempted: false, confirmed: false, conflict: false })
    }
  }
  for (const [id, candidate] of outcomes) {
    const capture = () => {
      const verdict = runtime.getPtyLivenessVerdict(id)
      if (
        candidate.incarnationId &&
        verdict?.status === 'exited' &&
        verdict.incarnationId === candidate.incarnationId
      ) {
        candidate.confirmed = true
        candidate.exitCaptured = true
        candidate.retirement = runtime.waitForPtyExitRetirement?.(id, candidate.incarnationId)
        void candidate.retirement?.then(
          (result) => {
            candidate.retirementResult = result
          },
          () => {
            candidate.retirementResult = false
          }
        )
      }
    }
    capture()
    const release = runtime.subscribeToPtyExit?.(id, capture)
    if (release) {
      unsubscribe.push(release)
    }
  }
  return outcomes
}

export function ptyStopOutcomeIsCurrent(
  id: string,
  candidate: WorktreePtyStopOutcome,
  snapshot?: WorktreeTerminalStopSnapshot,
  providerEvidence?: FinalPtyStopProviderEvidence
): boolean {
  try {
    const providerIdentity = providerEvidence?.identities.get(id)
    if (
      providerIdentity &&
      (providerIdentity.ambiguous ||
        providerIdentity.incarnationId !== candidate.incarnationId ||
        (providerIdentity.worktreeId !== undefined &&
          providerIdentity.worktreeId !== providerEvidence?.worktreeId))
    ) {
      return false
    }
    snapshot?.assertCurrent(id)
    return (
      !candidate.conflict &&
      Boolean(candidate.incarnationId) &&
      isCurrentPtyExit({ id, incarnationId: candidate.incarnationId })
    )
  } catch {
    return false
  }
}

export async function finishPtyStopOutcome(
  id: string,
  candidate: WorktreePtyStopOutcome,
  runtime: WorktreeTeardownRuntime,
  snapshot: WorktreeTerminalStopSnapshot | undefined,
  providerAbsent: boolean,
  deadline: number,
  onPtyStopped?: (id: string) => void,
  providerEvidence?: FinalPtyStopProviderEvidence
): Promise<boolean> {
  if (!ptyStopOutcomeIsCurrent(id, candidate, snapshot, providerEvidence)) {
    return false
  }
  const verdict = runtime.getPtyLivenessVerdict(id)
  const exited = verdict?.status === 'exited' && verdict.incarnationId === candidate.incarnationId
  candidate.confirmed ||= (providerAbsent && candidate.allowAbsenceProof !== false) || exited
  if (!candidate.confirmed) {
    return false
  }
  const retired =
    candidate.retirementResult ??
    (await settleBeforeDeadline(
      async () => {
        if (candidate.exitCaptured) {
          return await (candidate.retirement ?? false)
        }
        if (exited) {
          return await (runtime.waitForPtyExitRetirement?.(id, candidate.incarnationId) ?? false)
        }
        if (!runtime.onPtyExit) {
          return false
        }
        await runtime.onPtyExit(id, 0, candidate.incarnationId, { hostExitConfirmed: true })
        return await (candidate.retirement ??
          runtime.waitForPtyExitRetirement?.(id, candidate.incarnationId) ??
          true)
      },
      false,
      deadline
    ))
  return (
    retired &&
    ptyStopOutcomeIsCurrent(id, candidate, snapshot, providerEvidence) &&
    clearStoppedPtyState(id, onPtyStopped, candidate.incarnationId)
  )
}

export function recordPtyStopEvidence(
  candidate: WorktreePtyStopOutcome | undefined,
  incarnationId?: string,
  evidence?: PtyShutdownEvidence
): void {
  if (candidate && evidence?.allowAbsenceProof === false) {
    candidate.allowAbsenceProof = false
  }
  if (
    candidate &&
    !candidate.conflict &&
    incarnationId &&
    candidate.incarnationId === incarnationId &&
    evidence?.confirmed !== false
  ) {
    candidate.confirmed = true
  }
}
