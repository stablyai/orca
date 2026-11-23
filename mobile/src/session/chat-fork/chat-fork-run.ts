import type { TuiAgent } from '../../../../src/shared/agent-launch/catalog/tui-agent'
import { TUI_AGENT_DISPLAY_NAMES } from '../../../../src/shared/agent-launch/catalog/tui-agent-display-names'
import type { StructuredAgentSessionForkSource } from '../../../../src/shared/agent-session/lifecycle/operations/structured-agent-session-create'
import { chatForkTransferErrorCode } from '../../../../src/shared/ai-vault/fork-transfer/chat-fork-transfer-limits'
import { triggerError } from '../../platform/haptics/haptics'
import type { RpcClient } from '../../transport/rpc/rpc-client-contract'
import type { MobileWorktreeForkMode } from '../mobile-structured-chat-worktree-fork'
import { chatForkCopy } from './chat-fork-copy'
import type { ChatForkRecapScope } from '../../../../src/shared/agent-session/conversation-context/chat-fork-recap'
import type {
  ChatForkPath,
  ChatForkSurface
} from '../../../../src/shared/native-chat/chat-fork-path'
import type { ChatForkRunAs, ChatForkWorkspace } from './chat-fork-selection'
import {
  launchChatForkInWorkspace,
  relayChatForkToHost,
  type ChatForkLaunchOutcome,
  type ChatForkWorkspaceLaunch
} from './chat-fork-workspace-launch'

export type ChatForkRunSource = {
  client: RpcClient | null
  hostId: string
  worktreeId: string
  agent: TuiAgent
  terminal: boolean
  /** The chat up to the fork point as a first message; null when it has no words to hand over. */
  recap: (scope: ChatForkRecapScope, throughItemId: string) => string | null
}

export type ChatForkRunDeps = {
  /** This chat's existing fork beside it; a recap starts another chat there instead. */
  createFork: (
    agent: TuiAgent,
    forkFrom: StructuredAgentSessionForkSource,
    recap?: string
  ) => Promise<void>
  createWorktreeFork: (
    agent: TuiAgent,
    forkFrom: StructuredAgentSessionForkSource,
    mode: MobileWorktreeForkMode,
    recap?: string,
    openIn?: (client: RpcClient, worktreeId: string) => Promise<ChatForkLaunchOutcome>
  ) => Promise<void>
  /** Holds a connection to a host for the whole transfer and launch. */
  acquireHost: (hostId: string) => { client: RpcClient | null; release: () => void }
  openSession: (hostId: string, worktreeId: string, name: string) => void
  onProgress: (message: string | null) => void
  showToast: (message: string, durationMs?: number) => void
}

export type ChatForkRunTarget = {
  hostId: string
  hostLabel: string
  hostCapabilities: readonly string[] | undefined
  workspace: ChatForkWorkspace
  agent: TuiAgent
  runAs: ChatForkRunAs
  path: ChatForkPath
  openAs: ChatForkSurface
  recapScope: ChatForkRecapScope
}

type Report = (message: string) => void

/** Places the fork in `worktreeId` on the held host and opens it: relayed there first, or a recap. */
async function openForkIn(
  source: ChatForkRunSource,
  deps: ChatForkRunDeps,
  target: ChatForkRunTarget,
  forkFrom: StructuredAgentSessionForkSource,
  client: RpcClient,
  worktreeId: string,
  recap: string | undefined,
  report: Report
): Promise<ChatForkLaunchOutcome | null> {
  let launch: ChatForkWorkspaceLaunch
  let placedIn = worktreeId
  if (target.path === 'relay') {
    if (!source.client) {
      report(chatForkCopy.offline(target.hostLabel))
      return null
    }
    deps.onProgress(chatForkCopy.copying(target.hostLabel, 0))
    try {
      const relayed = await relayChatForkToHost({
        sourceClient: source.client,
        targetClient: client,
        terminal: source.terminal,
        openAs: target.openAs,
        sourceWorktreeId: source.worktreeId,
        forkFrom,
        targetWorktreeId: worktreeId,
        onProgress: (done, total) =>
          deps.onProgress(
            chatForkCopy.copying(target.hostLabel, total > 0 ? Math.floor((done / total) * 100) : 0)
          )
      })
      launch = relayed.launch
      placedIn = relayed.worktreeId
    } catch (error) {
      report(relayFailureMessage(error, target.hostLabel))
      return null
    }
  } else {
    launch = recap
      ? { kind: 'recap', recap, surface: target.openAs }
      : { kind: 'copy', terminal: source.terminal, forkFrom }
  }
  deps.onProgress(chatForkCopy.opening(target.hostLabel))
  // Past this point the fork may exist, so an unexpected throw reads as unconfirmed.
  return launchChatForkInWorkspace(
    client,
    placedIn,
    target.agent,
    launch,
    target.hostCapabilities
  ).catch((): ChatForkLaunchOutcome => ({ kind: 'unconfirmed' }))
}

/** Forks the chat where the sheet says: copied here, relayed (to another host or the other kind),
 *  or recapped, opened as a chat or in a terminal. */
export async function runChatFork(
  source: ChatForkRunSource,
  deps: ChatForkRunDeps,
  target: ChatForkRunTarget,
  forkFrom: StructuredAgentSessionForkSource
): Promise<void> {
  const report: Report = (message) => {
    triggerError()
    deps.showToast(message, 4000)
  }
  let recap: string | undefined
  if (target.path === 'recap') {
    recap = source.recap(target.recapScope, forkFrom.throughItemId) ?? undefined
    if (!recap) {
      report(chatForkCopy.noRecap())
      return
    }
  }
  const { workspace } = target
  // The paths the sheet always had: an exact copy here, or a recap opened as a chat.
  const ownPath = target.path === 'same' || (recap !== undefined && target.openAs === 'chat')
  if (workspace.kind === 'new') {
    const mode = target.runAs === 'subagent' ? 'subagent' : 'worktree'
    if (ownPath) {
      return deps.createWorktreeFork(target.agent, forkFrom, mode, recap)
    }
    return deps.createWorktreeFork(target.agent, forkFrom, mode, recap, (client, worktreeId) =>
      openForkIn(source, deps, target, forkFrom, client, worktreeId, recap, report).then(
        (outcome) => outcome ?? { kind: 'reported' }
      )
    )
  }
  if (workspace.kind === 'this' && ownPath) {
    return deps.createFork(target.agent, forkFrom, recap)
  }
  const sameHost = target.hostId === source.hostId
  const held = sameHost
    ? { client: source.client, release: () => {} }
    : deps.acquireHost(target.hostId)
  try {
    if (!held.client) {
      report(chatForkCopy.offline(target.hostLabel))
      return
    }
    const worktreeId = workspace.kind === 'this' ? source.worktreeId : workspace.worktreeId
    const outcome = await openForkIn(
      source,
      deps,
      target,
      forkFrom,
      held.client,
      worktreeId,
      recap,
      report
    )
    if (!outcome) {
      return
    }
    const agentName = TUI_AGENT_DISPLAY_NAMES[target.agent]
    if (
      (outcome.kind === 'opened' || outcome.kind === 'unconfirmed') &&
      workspace.kind === 'existing'
    ) {
      deps.openSession(target.hostId, worktreeId, workspace.name)
    }
    if (outcome.kind === 'unconfirmed') {
      report(chatForkCopy.unconfirmed(agentName))
    } else if (outcome.kind === 'failed') {
      report(chatForkCopy.failed(agentName, outcome.message || chatForkCopy.unsupported()))
    }
  } finally {
    held.release()
    deps.onProgress(null)
  }
}

function relayFailureMessage(error: unknown, host: string): string {
  switch (chatForkTransferErrorCode(error)) {
    case 'chat_fork_transfer_too_large':
      return chatForkCopy.tooLarge()
    case 'chat_fork_transfer_busy':
      return chatForkCopy.busy(host)
    case 'chat_fork_import_target_unsupported':
      return chatForkCopy.targetUnsupported()
    case 'chat_fork_source_unavailable':
      return chatForkCopy.sourceUnavailable()
    case 'chat_fork_transfer_integrity_failed':
    case 'chat_fork_transfer_not_found':
    case 'chat_fork_transfer_offset_mismatch':
    case null: {
      const detail = error instanceof Error ? error.message.trim() : ''
      return chatForkCopy.relayFailed(host, detail)
    }
  }
}
