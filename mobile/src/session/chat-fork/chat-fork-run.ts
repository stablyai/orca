import type { TuiAgent } from '../../../../src/shared/agent-launch/catalog/tui-agent'
import { TUI_AGENT_DISPLAY_NAMES } from '../../../../src/shared/agent-launch/catalog/tui-agent-display-names'
import type { StructuredAgentSessionForkSource } from '../../../../src/shared/agent-session/structured-agent-session-create'
import { chatForkTransferErrorCode } from '../../../../src/shared/ai-vault/fork-transfer/chat-fork-transfer-limits'
import type { NativeChatMessage } from '../../../../src/shared/native-chat/native-chat-types'
import { triggerError } from '../../platform/haptics/haptics'
import type { RpcClient } from '../../transport/rpc/rpc-client-contract'
import type { MobileWorktreeForkMode } from '../mobile-structured-chat-worktree-fork'
import { chatForkCopy } from './chat-fork-copy'
import { buildChatForkRecap } from './chat-fork-recap'
import { chatForkRoute, type ChatForkRunAs, type ChatForkWorkspace } from './chat-fork-selection'
import {
  launchChatForkInWorkspace,
  relayChatForkToHost,
  type ChatForkWorkspaceLaunch
} from './chat-fork-workspace-launch'

export type ChatForkRunSource = {
  client: RpcClient | null
  hostId: string
  worktreeId: string
  agent: TuiAgent
  terminal: boolean
  title?: string
  messages: readonly NativeChatMessage[]
}

export type ChatForkRunDeps = {
  /** This chat's existing fork beside it; a recap starts another agent there instead. */
  createFork: (
    agent: TuiAgent,
    forkFrom: StructuredAgentSessionForkSource,
    recap?: string
  ) => Promise<void>
  createWorktreeFork: (
    agent: TuiAgent,
    forkFrom: StructuredAgentSessionForkSource,
    mode: MobileWorktreeForkMode,
    recap?: string
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
  workspace: ChatForkWorkspace
  agent: TuiAgent
  runAs: ChatForkRunAs
}

/** Forks the chat where the sheet says: copied here, relayed to another host, or recapped for another agent. */
export async function runChatFork(
  source: ChatForkRunSource,
  deps: ChatForkRunDeps,
  target: ChatForkRunTarget,
  forkFrom: StructuredAgentSessionForkSource
): Promise<void> {
  const report = (message: string): void => {
    triggerError()
    deps.showToast(message, 4000)
  }
  const route = chatForkRoute(source, target)
  let recap: string | undefined
  if (route === 'recap') {
    recap =
      buildChatForkRecap({
        messages: source.messages,
        throughMessageId: forkFrom.throughItemId,
        sourceAgent: source.agent,
        sourceTitle: source.title
      }) ?? undefined
    if (!recap) {
      report(chatForkCopy.noRecap())
      return
    }
  }
  const { workspace } = target
  if (workspace.kind === 'this') {
    return deps.createFork(target.agent, forkFrom, recap)
  }
  if (workspace.kind === 'new') {
    const mode = target.runAs === 'subagent' ? 'subagent' : 'worktree'
    return deps.createWorktreeFork(target.agent, forkFrom, mode, recap)
  }
  const sameHost = target.hostId === source.hostId
  const held = sameHost
    ? { client: source.client, release: () => {} }
    : deps.acquireHost(target.hostId)
  try {
    if (!held.client || !source.client) {
      report(chatForkCopy.offline(target.hostLabel))
      return
    }
    let launch: ChatForkWorkspaceLaunch
    let worktreeId = workspace.worktreeId
    if (route === 'relay') {
      deps.onProgress(chatForkCopy.copying(target.hostLabel, 0))
      try {
        const relayed = await relayChatForkToHost({
          sourceClient: source.client,
          targetClient: held.client,
          terminal: source.terminal,
          sourceWorktreeId: source.worktreeId,
          forkFrom,
          targetWorktreeId: workspace.worktreeId,
          onProgress: (done, total) =>
            deps.onProgress(
              chatForkCopy.copying(
                target.hostLabel,
                total > 0 ? Math.floor((done / total) * 100) : 0
              )
            )
        })
        launch = relayed.launch
        worktreeId = relayed.worktreeId
      } catch (error) {
        report(relayFailureMessage(error, target.hostLabel))
        return
      }
    } else {
      launch = recap
        ? { kind: 'recap', recap }
        : { kind: 'copy', terminal: source.terminal, forkFrom }
    }
    deps.onProgress(chatForkCopy.opening(target.hostLabel))
    const agentName = TUI_AGENT_DISPLAY_NAMES[target.agent]
    // Past this point the fork may exist, so an unexpected throw reads as unconfirmed.
    try {
      const outcome = await launchChatForkInWorkspace(held.client, worktreeId, target.agent, launch)
      if (outcome.kind !== 'failed') {
        deps.openSession(target.hostId, worktreeId, workspace.name)
      }
      if (outcome.kind === 'unconfirmed') {
        report(chatForkCopy.unconfirmed(agentName))
      } else if (outcome.kind === 'failed') {
        report(chatForkCopy.failed(agentName, outcome.message || chatForkCopy.unsupported()))
      }
    } catch {
      report(chatForkCopy.unconfirmed(agentName))
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
    default: {
      const detail = error instanceof Error ? error.message.trim() : ''
      return chatForkCopy.relayFailed(host, detail)
    }
  }
}
