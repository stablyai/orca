import type { MailboxDeliveryHold } from '../../orchestration/mailbox/delivery-hold/mailbox-delivery-hold'
import {
  evaluateTuiIdle,
  hasQuietReadyScreen,
  isTuiIdleReadyVerdict,
  type TuiIdleVerdict
} from './tui-idle-evidence'
import { ptyTuiIdleEvidence, type TuiIdleEvidenceSource } from './tui-idle-evidence-source'
import type { RuntimePtyWorktreeRecord } from '../records/runtime-terminal-state-records'

export function mailboxDeliveryTuiVerdict(
  source: TuiIdleEvidenceSource,
  pty: RuntimePtyWorktreeRecord,
  readWaitText: () => string,
  recovering: boolean,
  readComposerText: () => string | null,
  stagedText?: string
) {
  const admissionSource = source
  const screen = recovering ? source.readScreenLines(pty.ptyId) : null
  if (recovering) {
    // An execution identity cannot renew an old hook's readiness or a tail's composer.
    source = {
      ...source,
      getAdoptedPtyIdleStatus: () => null,
      getFirstPartyAgentStatus: () => null,
      getHookTurn: undefined,
      readScreenLines: () => screen
    }
  }
  const evidence = ptyTuiIdleEvidence(
    source,
    recovering ? { ...pty, lastOscTitle: null } : pty,
    recovering ? () => screen?.join('\n') ?? '' : readWaitText
  )
  let verdict: TuiIdleVerdict =
    recovering && screen === null
      ? { kind: 'pending', quietForeground: 'closed' }
      : evaluateTuiIdle({
          ...evidence,
          readPositiveBodyEvidence: () =>
            evidence.readPositiveBodyEvidence() ||
            (recovering &&
              evidence.readAgentRuleVerdict() === null &&
              hasQuietReadyScreen(
                evidence.record,
                null,
                () => {
                  const text = readComposerText()
                  return text === '' || text === stagedText
                },
                source.quiescenceMs
              )),
          // A current screen can veto recovery; old blocked tail text cannot veto ordinary delivery.
          readTailBlockedReason: recovering ? evidence.readTailBlockedReason : () => null
        })
  const screenReady = isTuiIdleReadyVerdict(verdict)
  if (recovering && screenReady) {
    const current = ptyTuiIdleEvidence(admissionSource, pty, readWaitText)
    verdict = evaluateTuiIdle({
      ...current,
      readPositiveBodyEvidence: () => screenReady,
      readTailBlockedReason: evidence.readTailBlockedReason,
      readScreenInputVeto: evidence.readScreenInputVeto
    })
  }
  return { verdict, readScreenInputVeto: evidence.readScreenInputVeto }
}

/** Why pointer plus Enter would not be typed into a settled-looking worker terminal now (dialogs and
 *  drafts are checked first); null means it would. Takes the waits' readiness ranking plus a working
 *  verdict: agents queue or steer text sent mid-turn. */
export function terminalDeliveryRefusal(input: {
  verdict: TuiIdleVerdict
  recognizedAgent: boolean
  readScreenInputVeto: () => boolean | null | undefined
}): MailboxDeliveryHold | null {
  const { verdict } = input
  // The ranking vetoes overlays only on ready verdicts; an overlay refuses input mid-turn too.
  // Only a recognized agent queues mid-turn text; an unknown program would read it as stdin.
  if (verdict.kind === 'working') {
    return !input.recognizedAgent
      ? { kind: 'busy-program' }
      : input.readScreenInputVeto() === true
        ? { kind: 'overlay' }
        : null
  }
  if (isTuiIdleReadyVerdict(verdict)) {
    return null
  }
  return verdict.kind === 'blocked'
    ? { kind: 'blocked', reason: verdict.reason }
    : { kind: 'unsettled' }
}
