// Gathers each tui-idle evaluation's evidence from runtime state; tui-idle-evidence.ts ranks it.
import type { AgentStatus } from '../../../../shared/agent-status/title/agent-title-core'
import type { TuiAgent } from '../../../../shared/agent-launch/catalog/tui-agent'
import type { TerminalAgent } from '../../../../shared/agent-status/identity/terminal-agent'
import type { RuntimeTerminalWaitBlockedReason } from '../../../../shared/runtime-terminal-contracts'
import { isTuiAgent } from '../../../../shared/agent-launch/catalog/tui-agent-config'
import type { RuntimePtyWorktreeRecord } from '../records/runtime-terminal-state-records'
import {
  detectTerminalWaitBlockedReason,
  isKnownReadyPromptBody,
  isQuietReadyScreenBody
} from './terminal-wait-detection'
import { readScreenInputVeto, type RuledScreen } from './screen-input-veto'
import {
  evaluateAgentStateRules,
  readsTrustedScreen,
  type AgentStateVerdict
} from '../../agent-state-rules/agent-state-rules-engine'
import type { TuiIdleHookTurn } from './tui-idle-hook-lane'
import {
  hasTerminalAgentPainted,
  terminalTitleIsPredecessor,
  terminalOriginIsPredecessor
} from '../input/terminal-command-paint'
import { readTerminalActionText, type TerminalActionText } from '../output/terminal-action-text'
import type {
  TerminalContentOrigin,
  TerminalSupportQuery
} from '../../../../shared/terminal/output/terminal-content-origin'
import type { PtyStartupObservation } from '../lifecycle/pty-startup-observation'
import type { TerminalPermissionDecision } from './terminal-permission-evidence'
import type {
  FirstPartyAgentStatus,
  TuiIdleEvaluationInput,
  TuiIdleEvidenceRecord
} from './tui-idle-evidence'

/** The runtime state every tui-idle site reads its evidence from. */
export type TuiIdleEvidenceSource = {
  readPermissionEvidence?(
    ptyId: string,
    text: TerminalActionText,
    reason: RuntimeTerminalWaitBlockedReason | null,
    screen?: readonly string[] | null
  ): TerminalPermissionDecision
  captureGeneration?(ptyId: string): () => boolean
  quiescenceMs: number
  getAdoptedPtyIdleStatus(pty: RuntimePtyWorktreeRecord): AgentStatus | null
  getPaneAgent(ptyId: string | null | undefined): TuiAgent | null
  getPaneTerminalAgent?(ptyId: string | null | undefined): TerminalAgent | null
  getFirstPartyAgentStatus(ptyId: string | null | undefined): FirstPartyAgentStatus
  /** The hook server's fresh row for the pane's main agent; absent on a host with no store. */
  getHookTurn?(ptyId: string, agent: TuiAgent): TuiIdleHookTurn | null
  readScreenLines(ptyId: string | null | undefined): readonly string[] | null
  /** The painted grid on the PTY's own size, which only agents whose rules read the trusted
   *  screen, and screen vetoes, use. Absent, they have no trustworthy screen. */
  readRuledScreen?(ptyId: string | null | undefined): RuledScreen | null
  /** The PTY's quiet clock: its last output, else when main began receiving its silent stream. */
  getOutputClockAt?(ptyId: string | null | undefined): number | null
  startupObservation?: Pick<PtyStartupObservation, 'read' | 'watch' | 'refresh'>
  /** Whether mail delivery would type into this pane now (drafts, prompts and overlays hold it). */
  isSettledForDelivery?(ptyId: string): boolean
}

/** One clock per terminal, read by ptyId. */
export function outputClockOf(
  source: Pick<TuiIdleEvidenceSource, 'getOutputClockAt'>,
  record: { ptyId: string | null; lastOutputAt: number | null }
): number | null {
  return source.getOutputClockAt?.(record.ptyId) ?? record.lastOutputAt
}

function evidenceRecord(
  source: TuiIdleEvidenceSource,
  record: TuiIdleEvidenceRecord & { ptyId: string | null }
): TuiIdleEvidenceRecord {
  return {
    lastAgentStatus: record.lastAgentStatus,
    lastOscTitle: record.lastOscTitle,
    lastOutputAt: outputClockOf(source, record)
  }
}

// Why per agent: every other agent keeps the live screen its rules were recorded against.
// Why read once: several lanes consult the rules, and one evaluation sees one screen.
function screenReader(
  source: TuiIdleEvidenceSource,
  agent: TuiAgent | null,
  ptyId: string | null | undefined
): () => readonly string[] | null {
  let lines: readonly string[] | null | undefined
  const read = readsTrustedScreen(agent)
    ? () => source.readRuledScreen?.(ptyId)?.lines ?? null
    : () => source.readScreenLines(ptyId)
  return () => (lines === undefined ? (lines = read()) : lines)
}

function readAgentRuleVerdict(
  agent: TuiAgent | null,
  record: TuiIdleEvidenceRecord,
  readScreenLines: () => readonly string[] | null,
  waitText: () => string,
  textSupport?: TerminalSupportQuery,
  contentScope?: TerminalContentOrigin
): AgentStateVerdict | null {
  return evaluateAgentStateRules(agent, {
    readScreenLines,
    readText: () => waitText().toLowerCase(),
    readTitleStatus: () => record.lastAgentStatus,
    textSupport,
    contentScope,
    hasOutputClock: record.lastOutputAt !== null
  })
}

function hookTurnReader(
  source: TuiIdleEvidenceSource,
  agent: TuiAgent | null,
  ptyId: string | null | undefined
): (() => TuiIdleHookTurn | null) | undefined {
  return source.getHookTurn && agent && ptyId
    ? () => source.getHookTurn?.(ptyId, agent) ?? null
    : undefined
}

function screenInputVetoReader(
  source: TuiIdleEvidenceSource,
  agent: TuiAgent | null,
  ptyId: string | null | undefined
): () => boolean | null {
  // Why memoized: the OMP lane and the veto over the verdict both ask within one evaluation.
  let read = false
  let veto: boolean | null = null
  return () => {
    if (!read) {
      veto = readScreenInputVeto(agent, () => source.readRuledScreen?.(ptyId) ?? null)
      read = true
    }
    return veto
  }
}

export function ptyTuiIdleEvidence(
  source: TuiIdleEvidenceSource,
  pty: RuntimePtyWorktreeRecord,
  readWaitText: () => string,
  readTailBlockedReason?: () => RuntimeTerminalWaitBlockedReason | null,
  actionView?: TerminalActionText
): TuiIdleEvaluationInput {
  const actionText = actionView ?? readTerminalActionText(pty, readWaitText)
  const waitText = () => actionText.text
  const scope = pty.commandPaint?.contentOrigin
  const oldTitle = terminalTitleIsPredecessor(pty)
  const startup = source.startupObservation?.read(pty.ptyId)
  const noninteractive = startup?.kind === 'agent' && startup.inputMode === 'noninteractive'
  const commandBoundaryPending = pty.commandPaint?.commandBoundaryPending === true
  const terminalAgent =
    noninteractive ||
    commandBoundaryPending ||
    startup?.kind === 'non-agent' ||
    startup?.kind === 'shell'
      ? null
      : ((source.getPaneTerminalAgent
          ? source.getPaneTerminalAgent(pty.ptyId)
          : source.getPaneAgent(pty.ptyId)) ?? (startup?.kind === 'agent' ? startup.agent : null))
  const agent = isTuiAgent(terminalAgent) ? terminalAgent : null
  const readScreen = screenReader(source, agent, pty.ptyId)
  const record = evidenceRecord(source, pty)
  if (oldTitle || noninteractive) {
    record.lastOscTitle = null
  }
  const statusOrigin = pty.commandPaint?.titleStatusOrigin
  if (
    noninteractive ||
    (pty.commandPaint && terminalOriginIsPredecessor(pty.commandPaint, statusOrigin))
  ) {
    record.lastAgentStatus = null
  }
  let blocked: RuntimeTerminalWaitBlockedReason | null | undefined
  const readBlocked = (): RuntimeTerminalWaitBlockedReason | null => {
    if (noninteractive) {
      return null
    }
    if (blocked !== undefined) {
      return blocked
    }
    blocked = actionText.query
      ? detectTerminalWaitBlockedReason(waitText(), actionText.query)
      : readTailBlockedReason
        ? readTailBlockedReason()
        : detectTerminalWaitBlockedReason(waitText())
    if (source.readPermissionEvidence) {
      const decision = source.readPermissionEvidence(
        pty.ptyId,
        actionText,
        blocked,
        actionView ? (source.readRuledScreen?.(pty.ptyId)?.lines ?? null) : undefined
      )
      blocked = decision.kind === 'superseded' || decision.kind === 'none' ? null : decision.reason
    }
    return blocked
  }
  return {
    record,
    readTailBlockedReason: readBlocked,
    readPositiveBodyEvidence: () =>
      !noninteractive &&
      ((!oldTitle &&
        agent !== 'qoder' &&
        agent !== 'qoder-cn' &&
        agent !== 'hermes' &&
        source.getAdoptedPtyIdleStatus(pty) === 'idle') ||
        isKnownReadyPromptBody(
          waitText(),
          agent,
          readScreen,
          record.lastOutputAt !== null,
          actionText.query,
          scope
        )),
    readQuietReadyBodyEvidence: () =>
      noninteractive ||
      isQuietReadyScreenBody(waitText(), agent, readScreen, actionText.query, scope),
    readAgentRuleVerdict: () =>
      noninteractive
        ? null
        : readAgentRuleVerdict(agent, record, readScreen, waitText, actionText.lowerQuery, scope),
    readScreenInputVeto: noninteractive
      ? () => null
      : screenInputVetoReader(source, agent, pty.ptyId),
    titleObservedAtEpochMs: pty.lastOscTitleEpochMs,
    agent,
    terminalAgent,
    commandBoundaryPending,
    shellStartup: startup?.kind === 'shell',
    firstPartyStatus: noninteractive ? null : source.getFirstPartyAgentStatus(pty.ptyId),
    readHookTurn: noninteractive ? undefined : hookTurnReader(source, agent, pty.ptyId),
    quiescenceMs: source.quiescenceMs,
    // Why per agent: Claude's corroboration is its own composer marker, which no shell hook can print.
    readCommandPainted: () =>
      hasTerminalAgentPainted(pty, startup?.kind === 'shell' ? startup.candidate : agent)
  }
}
