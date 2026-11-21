import type { TuiAgent } from '../../../../src/shared/agent-launch/catalog/tui-agent'
import type { ChatForkRecapScope } from '../../../../src/shared/agent-session/conversation-context/chat-fork-recap'
import type { StructuredAgentSessionForkSource } from '../../../../src/shared/agent-session/lifecycle/operations/structured-agent-session-create'
import {
  BRIDGE_CHAT_FORK_RECAP_MAX_CHARS,
  type BridgeChatForkParams,
  type BridgeChatForkResult
} from '../../mobile-web-shell/bridge/native-capabilities/bridge-chat-fork-verb'
import { chatForkCopy } from './chat-fork-copy'
import type { ChatForkRunTarget } from './chat-fork-run'
import type { ChatForkPreset } from './chat-fork-selection'
import type { MobileChatForkSheetSource } from './MobileChatForkSheet'

/** Runs a fork the sheet chose on this chat's host; the caller holds the fork gate. */
export type ChatForkRunHere = (
  agent: TuiAgent,
  target: ChatForkRunTarget,
  forkFrom: StructuredAgentSessionForkSource
) => Promise<void>

/** What the page tells the app's Fork sheet about its chat and the response it forks from. */
export function chatForkShellParams(
  source: MobileChatForkSheetSource,
  preset: ChatForkPreset,
  forkFrom: StructuredAgentSessionForkSource,
  recap: (scope: ChatForkRecapScope, throughItemId: string) => string | null
): BridgeChatForkParams {
  const recapFor = (scope: ChatForkRecapScope): string | null => {
    const text = recap(scope, forkFrom.throughItemId)
    return text && text.length <= BRIDGE_CHAT_FORK_RECAP_MAX_CHARS ? text : null
  }
  return {
    worktreeId: source.worktreeId,
    agent: source.agent,
    surface: source.surface,
    usageLimited: source.usageLimited,
    canCopy: source.canCopy,
    canExport: source.canExport,
    canNewWorktree: source.canNewWorktree,
    canSubagent: source.canSubagent,
    capabilities: [...(source.capabilities ?? [])],
    preset,
    forkFrom: { sessionId: forkFrom.sessionId, throughItemId: forkFrom.throughItemId },
    recaps: { history: recapFor('history'), current: recapFor('current') }
  }
}

/** Runs a fork the shell handed back for this host, or says what the shell's own run reported. */
export async function settleShellAnswer(
  answer: BridgeChatForkResult,
  source: MobileChatForkSheetSource,
  forkFrom: StructuredAgentSessionForkSource,
  deps: {
    copyOffered: () => boolean
    runHere: ChatForkRunHere
    showToast: (message: string, durationMs?: number) => void
  }
): Promise<void> {
  if (answer.outcome === 'done') {
    for (const notice of answer.notices) {
      deps.showToast(notice, 4000)
    }
    return
  }
  if (answer.outcome === 'cancelled') {
    return
  }
  const { target } = answer
  // Only this chat's own host comes back; the shell runs every other one itself.
  const here =
    target.hostId === source.hostId &&
    (target.workspace.kind !== 'existing' || target.workspace.hostId === source.hostId)
  if (!here || (target.path !== 'recap' && !deps.copyOffered())) {
    deps.showToast(chatForkCopy.notNow(), 3000)
    return
  }
  await deps.runHere(
    source.agent,
    { ...target, hostCapabilities: target.hostCapabilities },
    forkFrom
  )
}
