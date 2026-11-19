import { agentStatusTakesTypedInput } from '../../orchestration/mailbox/routing/mailbox-owner'
import {
  openCodeComposerHoldsDraft,
  readOpenCodeComposerTypedText
} from '../../../../shared/terminal/input/opencode-composer'
import {
  readTerminalComposerTypedText,
  type TerminalCursorContext
} from '../../../../shared/terminal/input/terminal-composer-draft'
import type { MailboxDeliveryHold } from '../../orchestration/mailbox/delivery-hold/mailbox-delivery-hold'
import {
  evaluateTuiIdle,
  hasQuietReadyScreen,
  isTuiIdleReadyVerdict,
  type TuiIdleVerdict
} from './tui-idle-evidence'
import { ptyTuiIdleEvidence, type TuiIdleEvidenceSource } from './tui-idle-evidence-source'
import type { RuntimePtyWorktreeRecord } from '../records/runtime-terminal-state-records'

export function mailboxDeliveryRefusal(
  source: TuiIdleEvidenceSource,
  pty: RuntimePtyWorktreeRecord,
  readWaitText: () => string,
  recovering: boolean,
  readComposerText: () => string | null,
  recognizedAgent: boolean,
  stagedText?: string
) {
  const ownPointer = terminalComposerTextOwnsPointer(readComposerText(), stagedText)
  const admissionSource = source
  if (recovering && ownPointer) {
    source = { ...source, quiescenceMs: 0 }
  }
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
    recovering ? { ...pty, lastAgentStatus: null, lastOscTitle: null } : pty,
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
                  return (
                    terminalComposerTextOwnsPointer(text, stagedText) ||
                    (text === '' &&
                      (pty.lastAgentStatus === null ||
                        agentStatusTakesTypedInput(pty.lastAgentStatus)))
                  )
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
  return terminalDeliveryRefusal({
    verdict,
    recognizedAgent,
    readScreenInputVeto: evidence.readScreenInputVeto
  })
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

// OpenCode's composer has no prompt glyph, so only its own pane is read with its box layout.
export function mailboxComposerHoldsDraft(
  agent: string | null,
  context: TerminalCursorContext
): boolean {
  return agent === 'opencode' || agent === 'opencode2'
    ? openCodeComposerHoldsDraft(context)
    : !!readTerminalComposerTypedText(context)
}

export function readAgentTerminalComposerTypedText(
  agent: string | null,
  context: TerminalCursorContext | null | undefined
): string | null {
  if (context && (agent === 'opencode' || agent === 'opencode2')) {
    return readOpenCodeComposerTypedText(context)
  }
  return readTerminalComposerTypedText(context)
}

/** Agents paint hard-wrapped rows themselves, including breaks inside a word. */
export function terminalComposerTextOwnsPointer(
  shown: string | null | undefined,
  pointer: string | undefined
): boolean {
  if (!shown || !pointer) {
    return false
  }
  const expected = pointer.replace(/\s+/g, ' ').trim()
  let offset = 0
  for (const line of shown.split('\n')) {
    const row = line.trim().replace(/\s+/g, ' ')
    if (!expected.startsWith(row, offset)) {
      return false
    }
    offset += row.length
    if (expected[offset] === ' ') {
      offset++
    }
  }
  return offset === expected.length
}

/** A wait that accepts mid-turn input settles on a working agent exactly where mail would be typed in. */
export function settlesForMidTurnInput(
  verdict: TuiIdleVerdict,
  ptyId: string,
  source: Pick<TuiIdleEvidenceSource, 'isSettledForDelivery'>
): boolean {
  return verdict.kind === 'working' && source.isSettledForDelivery?.(ptyId) === true
}
