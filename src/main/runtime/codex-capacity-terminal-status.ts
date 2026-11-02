import {
  CodexCapacityNoticeTracker,
  CODEX_CAPACITY_MESSAGE
} from '../../shared/codex-capacity-notice'
import type {
  AgentStatusIpcPayload,
  ParsedAgentStatusPayload
} from '../../shared/agent-status-types'
import { recognizeAgentProcessFromCommandLine } from '../../shared/agent-process-recognition'
import type { HeadlessEmulator } from '../daemon/headless-emulator'

const trackers = new WeakMap<HeadlessEmulator, CodexCapacityNoticeTracker>()
const launchIdentities = new WeakMap<HeadlessEmulator, { command?: string; codex: boolean }>()
type CodexCapacityStatus = Pick<
  AgentStatusIpcPayload,
  'agentType' | 'prompt' | 'model' | 'subagents' | 'mainAgent' | 'turnStartedAt'
>

export function observeCodexCapacityTerminalStatus(
  emulator: HeadlessEmulator,
  data: string,
  startupCommand: string | undefined,
  launchAgent: string | null | undefined,
  readStatus: () => CodexCapacityStatus | undefined,
  outputObservedAt = Date.now()
): ParsedAgentStatusPayload | null {
  let tracker = trackers.get(emulator)
  if (!tracker && launchAgent !== 'codex') {
    let identity = launchIdentities.get(emulator)
    if (!identity || identity.command !== startupCommand) {
      identity = {
        command: startupCommand,
        codex: recognizeAgentProcessFromCommandLine(startupCommand)?.agent === 'codex'
      }
      launchIdentities.set(emulator, identity)
    }
    // A Codex started from an existing shell is identified by its host-owned hook row.
    if (
      !identity.codex &&
      ((!data.includes('■') && !data.includes('⚠')) || readStatus()?.agentType !== 'codex')
    ) {
      return null
    }
  }
  if (!tracker) {
    tracker = new CodexCapacityNoticeTracker()
    trackers.set(emulator, tracker)
  }
  if (
    !tracker.observe(
      data,
      () => emulator.getVisibleLines(),
      () => emulator.isSynchronizedOutput
    )
  ) {
    return null
  }
  const previous = readStatus()
  if (previous && previous.agentType !== 'codex') {
    return null
  }
  // Same-tick ordering is ambiguous; queued output must yield to a newer hook turn.
  if (previous?.turnStartedAt !== undefined && previous.turnStartedAt >= outputObservedAt) {
    return null
  }
  if (previous?.mainAgent?.outcome === 'failure') {
    return null
  }
  return {
    state: 'done',
    agentType: 'codex',
    prompt: previous?.prompt ?? '',
    model: previous?.model,
    subagents: previous?.subagents,
    lastAssistantMessage: CODEX_CAPACITY_MESSAGE,
    lastAssistantMessageIsToolOutput: true,
    mainAgent: { state: 'done', outcome: 'failure', stateStartedAt: Date.now() }
  }
}
