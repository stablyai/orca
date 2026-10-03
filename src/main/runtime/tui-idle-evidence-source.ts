// Gathers each tui-idle evaluation's evidence from runtime state; tui-idle-evidence.ts ranks it.
import type { AgentStatus } from '../../shared/agent-detection'
import type { TuiAgent } from '../../shared/tui-agent'
import type { RuntimeLeafRecord, RuntimePtyWorktreeRecord } from './runtime-terminal-state-records'
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
} from './agent-state-rules/agent-state-rules-engine'
import type { TuiIdleHookTurn } from './tui-idle-hook-lane'
import type {
  FirstPartyAgentStatus,
  TuiIdleEvaluationInput,
  TuiIdleEvidenceRecord
} from './tui-idle-evidence'

/** The runtime state every tui-idle site reads its evidence from. */
export type TuiIdleEvidenceSource = {
  quiescenceMs: number
  getTabTitle(tabId: string): string | null
  getAdoptedPtyIdleStatus(pty: RuntimePtyWorktreeRecord): AgentStatus | null
  getPaneAgent(ptyId: string | null | undefined): TuiAgent | null
  getFirstPartyAgentStatus(ptyId: string | null | undefined): FirstPartyAgentStatus
  /** The hook server's fresh row for the pane's main agent; absent on a host with no store. */
  getHookTurn?(ptyId: string, agent: TuiAgent): TuiIdleHookTurn | null
  readScreenLines(ptyId: string | null | undefined): readonly string[] | null
  /** The painted grid on the PTY's own size, which only agents whose rules read the trusted
   *  screen, and screen vetoes, use. Absent, they have no trustworthy screen. */
  readRuledScreen?(ptyId: string | null | undefined): RuledScreen | null
  /** When the PTY last observed a title of its own. Absent, no title has an age. */
  getTitleObservedAtEpochMs?(ptyId: string | null | undefined): number | null
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
  waitText: () => string
): AgentStateVerdict | null {
  return evaluateAgentStateRules(agent, {
    readScreenLines,
    readText: () => waitText().toLowerCase(),
    readTitleStatus: () => record.lastAgentStatus,
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

function lazyWaitText(readWaitText: () => string): () => string {
  let waitText: string | null = null
  return () => (waitText ??= readWaitText())
}

export function leafTuiIdleEvidence(
  source: TuiIdleEvidenceSource,
  leaf: RuntimeLeafRecord,
  readWaitText: () => string
): TuiIdleEvaluationInput {
  const waitText = lazyWaitText(readWaitText)
  const agent = source.getPaneAgent(leaf.ptyId)
  const readScreen = screenReader(source, agent, leaf.ptyId)
  return {
    record: leaf,
    readTailBlockedReason: () => detectTerminalWaitBlockedReason(waitText()),
    rendererTitle: leaf.paneTitle ?? source.getTabTitle(leaf.tabId),
    readPositiveBodyEvidence: () =>
      isKnownReadyPromptBody(waitText(), agent, readScreen, leaf.lastOutputAt !== null),
    readQuietReadyBodyEvidence: () => isQuietReadyScreenBody(waitText(), agent, readScreen),
    readAgentRuleVerdict: () => readAgentRuleVerdict(agent, leaf, readScreen, waitText),
    readScreenInputVeto: screenInputVetoReader(source, agent, leaf.ptyId),
    titleObservedAtEpochMs: source.getTitleObservedAtEpochMs?.(leaf.ptyId) ?? null,
    agent,
    firstPartyStatus: source.getFirstPartyAgentStatus(leaf.ptyId),
    readHookTurn: hookTurnReader(source, agent, leaf.ptyId),
    quiescenceMs: source.quiescenceMs
  }
}

export function ptyTuiIdleEvidence(
  source: TuiIdleEvidenceSource,
  pty: RuntimePtyWorktreeRecord,
  readWaitText: () => string
): TuiIdleEvaluationInput {
  const waitText = lazyWaitText(readWaitText)
  const agent = source.getPaneAgent(pty.ptyId)
  const readScreen = screenReader(source, agent, pty.ptyId)
  return {
    record: pty,
    readTailBlockedReason: () => detectTerminalWaitBlockedReason(waitText()),
    readPositiveBodyEvidence: () =>
      (agent !== 'qoder' && source.getAdoptedPtyIdleStatus(pty) === 'idle') ||
      isKnownReadyPromptBody(waitText(), agent, readScreen, pty.lastOutputAt !== null),
    readQuietReadyBodyEvidence: () => isQuietReadyScreenBody(waitText(), agent, readScreen),
    readAgentRuleVerdict: () => readAgentRuleVerdict(agent, pty, readScreen, waitText),
    readScreenInputVeto: screenInputVetoReader(source, agent, pty.ptyId),
    titleObservedAtEpochMs: pty.lastOscTitleEpochMs,
    agent,
    firstPartyStatus: source.getFirstPartyAgentStatus(pty.ptyId),
    readHookTurn: hookTurnReader(source, agent, pty.ptyId),
    quiescenceMs: source.quiescenceMs
  }
}
