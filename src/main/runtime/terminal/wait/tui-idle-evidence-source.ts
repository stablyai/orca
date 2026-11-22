// Gathers each tui-idle evaluation's evidence from runtime state; tui-idle-evidence.ts ranks it.
import type { AgentStatus } from '../../../../shared/agent-status/title/agent-title-core'
import type { TuiAgent } from '../../../../shared/agent-launch/catalog/tui-agent'
import type { RuntimePtyWorktreeRecord } from '../records/runtime-terminal-state-records'
import {
  detectTerminalWaitBlockedReason,
  isKnownReadyPromptBody,
  isQuietReadyScreenBody
} from './terminal-wait-detection'
import { readScreenInputVeto, type RuledScreen } from './screen-input-veto'
import { isProgramSignInWaitScreen } from './program-sign-in-screen'
import {
  evaluateAgentStateRules,
  readsTrustedScreen,
  type AgentStateVerdict
} from '../../agent-state-rules/agent-state-rules-engine'
import type { TuiIdleHookTurn } from './tui-idle-hook-lane'
import {
  hasTerminalAgentPainted,
  isCurrentCommandStatus,
  isCurrentFirstPartyReport,
  isShellInFront
} from '../input/terminal-command-paint'
import { resolveTerminalTitlePolicyAgentType } from '../../../../shared/agent-status/title/terminal-title-agent-type'
import { isTuiAgent } from '../../../../shared/agent-launch/catalog/tui-agent-config'
import { titleCommandLaunchesInteractiveTui } from '../../../../shared/agent-status/title/interactive-agent-title-command'
import { isPagerProcess } from '../../../../shared/agent-status/process/pager-process-detection'
import { hasExplicitIdleTitle } from './tui-idle-evidence'
import type {
  FirstPartyAgentStatus,
  TuiIdleEvaluationInput,
  TuiIdleEvidenceRecord
} from './tui-idle-evidence'

/** The runtime state every tui-idle site reads its evidence from. */
export type TuiIdleEvidenceSource = {
  quiescenceMs: number
  getAdoptedPtyIdleStatus(pty: RuntimePtyWorktreeRecord): AgentStatus | null
  getPaneAgent(ptyId: string | null | undefined): TuiAgent | null
  getFirstPartyAgentStatus(ptyId: string | null | undefined): FirstPartyAgentStatus
  /** The hook server's fresh row for the pane's main agent; absent on a host with no store. */
  getHookTurn?(ptyId: string, agent: TuiAgent): TuiIdleHookTurn | null
  readScreenLines(ptyId: string | null | undefined): readonly string[] | null
  /** The painted grid on the PTY's own size, which only agents whose rules read the trusted
   *  screen, and screen vetoes, use. Absent, they have no trustworthy screen. */
  readRuledScreen?(ptyId: string | null | undefined): RuledScreen | null
  /** The PTY's quiet clock: its last output, else when main began receiving its silent stream. */
  getOutputClockAt?(ptyId: string | null | undefined): number | null
  /** Whether mail delivery would type into this pane now (drafts, prompts and overlays hold it). */
  isSettledForDelivery?(ptyId: string): boolean
  /** The foreground process a poll read during the pane's current quiet stretch; absent before any
   *  such read, and once output has moved on. Only the idle polls supply it. */
  getQuietForegroundProcess?(ptyId: string | null | undefined): string | null
  /** The settled screen when it proves the tail's blocked text a dialog erased in place; null keeps the tail. */
  readScreenClearingBlockedTail?(ptyId: string): string | null
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

/** The agent whose paint corroborates a name-only idle: launch authority first, else the title's
 *  agent, the same fallback `nameOnlyIdleNeedsCorroboration` uses. Why: an adopted pane, or a Claude
 *  run through a command Orca does not recognize, is identified by its title alone; without this the
 *  title required corroboration while the paint check fell back to any visible byte, so a printing
 *  preexec hook could still settle it before the composer existed (STA-14925).
 *
 *  Why only a positively interactive title: a shell title is retained from the command's start, so
 *  `claude --help | less` or `claude -p …` keeps Claude's name while the live process (a pager, a
 *  one-shot) never draws Claude's composer; holding for that composer would wait out the caller's
 *  timeout. The gate therefore needs the title to read as the TUI itself (no pipe or redirect, no
 *  print or informational flag) and the quiet foreground, where a poll has read it, to be something
 *  other than a known non-agent such as a pager. Otherwise the pane keeps the any-visible-byte rule,
 *  as before. Not covered: a title whose tokens name a second agent (`claude --resume codex`), which
 *  the title policy attributes to that agent (STA-14961). */
function paintAgent(
  agent: TuiAgent | null,
  title: string | null | undefined,
  quietForegroundProcess: string | null
): TuiAgent | null {
  if (agent) {
    return agent
  }
  if (!title || isPagerProcess(quietForegroundProcess)) {
    return null
  }
  const fromTitle = resolveTerminalTitlePolicyAgentType(title)
  return isTuiAgent(fromTitle) && titleCommandLaunchesInteractiveTui(title, fromTitle)
    ? fromTitle
    : null
}

export function ptyTuiIdleEvidence(
  source: TuiIdleEvidenceSource,
  pty: RuntimePtyWorktreeRecord,
  readWaitText: () => string,
  /** The agent's own hook report, standing in for a title that names no status. */
  reportedStatus?: AgentStatus
): TuiIdleEvaluationInput {
  const tailText = lazyWaitText(readWaitText)
  // Why only after a tail block: the screen may clear one (#24187), and a clear tail never pays the read.
  let clearingScreenText: string | null = null
  const waitText = () => clearingScreenText ?? tailText()
  const agent = source.getPaneAgent(pty.ptyId)
  const readScreen = screenReader(source, agent, pty.ptyId)
  // Why: an agent's own ready report (explicit idle title, adopted idle, first-party done) from a
  // finished command or from before a reattach speaks for a program that may no longer be there.
  const titleIsCurrent = isCurrentCommandStatus(pty, pty.lastOscTitleEpochMs)
  const fullRecord = {
    ...evidenceRecord(source, pty),
    ...(reportedStatus ? { lastAgentStatus: reportedStatus } : {})
  }
  // Why not with the shell in front: once a command finished, the shell is itself at rest; only an
  // agent's own explicit rest title must not speak for it.
  // A reported status was already proven current for the running command.
  const statusRetired =
    !reportedStatus &&
    !titleIsCurrent &&
    !isShellInFront(pty) &&
    fullRecord.lastAgentStatus === 'idle'
  // With the shell in front, an exited agent's rest title must not leave its idle behind either.
  const record =
    titleIsCurrent || !hasExplicitIdleTitle(fullRecord)
      ? fullRecord
      : isShellInFront(pty)
        ? { ...fullRecord, lastOscTitle: null, lastAgentStatus: null }
        : { ...fullRecord, lastOscTitle: null }
  const firstPartyStatus = source.getFirstPartyAgentStatus(pty.ptyId)
  // Why per agent: Claude's corroboration is its own composer marker, which no shell hook can print.
  const readCommandPainted = () =>
    hasTerminalAgentPainted(
      pty,
      paintAgent(agent, record.lastOscTitle, source.getQuietForegroundProcess?.(pty.ptyId) ?? null)
    )
  // A ready screen speaks only for a command now running that painted it.
  const readScreenPainted = () => !isShellInFront(pty) && readCommandPainted()
  return {
    record,
    readTailBlockedReason: () => {
      const reason = detectTerminalWaitBlockedReason(tailText())
      if (reason === null) {
        return null
      }
      clearingScreenText = source.readScreenClearingBlockedTail?.(pty.ptyId) ?? null
      return clearingScreenText === null ? reason : null
    },
    // Why the paint fence on screens: a reused pane still shows the previous agent's ready screen
    // until the command now running paints its own.
    readPositiveBodyEvidence: () =>
      (agent !== 'qoder' &&
        agent !== 'qoder-cn' &&
        agent !== 'hermes' &&
        titleIsCurrent &&
        source.getAdoptedPtyIdleStatus(pty) === 'idle') ||
      (isKnownReadyPromptBody(waitText(), agent, readScreen, record.lastOutputAt !== null) &&
        readScreenPainted()),
    readQuietReadyBodyEvidence: () =>
      isQuietReadyScreenBody(waitText(), agent, readScreen) && readScreenPainted(),
    readAgentRuleVerdict: () => readAgentRuleVerdict(agent, record, readScreen, waitText),
    readScreenInputVeto: screenInputVetoReader(source, agent, pty.ptyId),
    readProgramSignInWaitScreen: () => isProgramSignInWaitScreen(waitText()),
    titleObservedAtEpochMs: pty.lastOscTitleEpochMs,
    agent,
    firstPartyStatus:
      firstPartyStatus && isCurrentFirstPartyReport(pty, firstPartyStatus)
        ? firstPartyStatus
        : null,
    readHookTurn: hookTurnReader(source, agent, pty.ptyId),
    quiescenceMs: source.quiescenceMs,
    readCommandPainted,
    statusRetired
  }
}
