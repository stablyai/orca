import type {
  RuntimeTerminalWait,
  RuntimeTerminalWaitBlockedReason
} from '../../shared/runtime-types'
import type { RuntimeLeafRecord, RuntimePtyWorktreeRecord } from './runtime-terminal-state-records'
import type { QuietForegroundLane, TuiIdleVerdict } from './tui-idle-evidence'
import type { TuiAgent } from '../../shared/tui-agent'
import { hasQuietReadyRules } from './agent-state-rules/agent-state-rules-engine'

export type IdlePollSample = {
  verdict: TuiIdleVerdict
  ptyId: string | null
  ready(): RuntimeTerminalWait
  blocked(reason: RuntimeTerminalWaitBlockedReason): RuntimeTerminalWait
  isQuiet(lane: QuietForegroundLane): boolean
  providerEligible: boolean
  isCurrent(): boolean
}

export function isCurrentIdleSample(
  sample: IdlePollSample,
  readLatest: () => IdlePollSample,
  provider: boolean
): boolean {
  if (!sample.isCurrent()) {
    return false
  }
  const latest = readLatest()
  return (
    latest.ptyId === sample.ptyId &&
    latest.verdict.kind === sample.verdict.kind &&
    (latest.verdict.kind !== 'blocked' ||
      (sample.verdict.kind === 'blocked' && latest.verdict.reason === sample.verdict.reason)) &&
    (!provider || latest.providerEligible) &&
    sample.isCurrent()
  )
}

// An unobserved output clock counts only for unknown panes; known agent commands must paint.
export function isQuietForQuiescence(
  lastOutputAt: number | null,
  quiescenceMs: number,
  lane: QuietForegroundLane,
  commandPainted: () => boolean
): boolean {
  if (lane === 'after-paint' && !commandPainted()) {
    return false
  }
  if (lastOutputAt === null) {
    return lane === 'open'
  }
  return Date.now() - lastOutputAt >= quiescenceMs
}

export function canReadQuietProvider(
  record: RuntimeLeafRecord | RuntimePtyWorktreeRecord
): boolean {
  return (
    record.lastOutputAt !== null &&
    record.lastAgentStatus !== 'working' &&
    record.lastAgentStatus !== 'permission'
  )
}

export function needsProviderScreen(
  sample: IdlePollSample,
  agent: TuiAgent | null,
  wholeScreen: readonly string[] | null | undefined
): boolean {
  return (
    wholeScreen == null &&
    hasQuietReadyRules(agent) &&
    sample.providerEligible &&
    sample.isQuiet('open')
  )
}
