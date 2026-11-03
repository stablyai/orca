import type { TuiAgent } from '../../shared/tui-agent'
import { formatAgentTypeLabel } from '../../shared/agent-type-label'
import {
  isNativeChatSupportedAgent,
  nativeChatRequiresLocalTranscript
} from '../../shared/native-chat/native-chat-agent-support'
import { resolveLaunchCommandPaneAgent } from './runtime-agent-launch-resolution'

function contradictionRefusal(commandAgent: string, recognized: TuiAgent): Error {
  return new Error(
    `--command-agent ${commandAgent} contradicts ${recognized}, the agent Orca recognizes in --command. No terminal was created; pass --command-agent ${recognized}.`
  )
}

/** Refuse a requested chat view this host can prove it cannot show, before any terminal exists. */
export function terminalChatViewRefusal(args: {
  commandAgent: TuiAgent
  /** The agent launch planning recognized in the command, if any. */
  plannedAgent: TuiAgent | null
  connectionId: string | null
}): Error | null {
  const { commandAgent, plannedAgent } = args
  if (plannedAgent && plannedAgent !== commandAgent) {
    return contradictionRefusal(commandAgent, plannedAgent)
  }
  const label = formatAgentTypeLabel(commandAgent)
  if (!isNativeChatSupportedAgent(commandAgent)) {
    return new Error(
      `${label} has no Chat UI view, so --view-mode chat cannot be applied. No terminal was created; omit --view-mode chat to open it as a terminal.`
    )
  }
  if (args.connectionId && nativeChatRequiresLocalTranscript(commandAgent)) {
    return new Error(
      `This workspace runs its terminals over SSH, and Orca can show ${label} as a chat only when its transcript is on this machine. No terminal was created; omit --view-mode chat, or create the terminal on the execution host itself.`
    )
  }
  return null
}

/** terminal.create's pairing rules; its workspace-less window path cannot check chat support at all. */
export function terminalCreateChatViewParamsRefusal(params: {
  viewMode?: 'terminal' | 'chat'
  commandAgent?: string
  worktree?: string
  command?: string
}): Error | null {
  if ((params.viewMode === 'chat') !== (params.commandAgent !== undefined)) {
    return new Error(
      '--view-mode chat and --command-agent must be given together. No terminal was created.'
    )
  }
  if (params.viewMode !== 'chat' || params.commandAgent === undefined) {
    return null
  }
  if (params.worktree === undefined) {
    return new Error('--view-mode chat needs a worktree. No terminal was created; pass --worktree.')
  }
  if (!params.command?.trim()) {
    return new Error(
      '--view-mode chat shows the agent that --command starts. No terminal was created; pass --command.'
    )
  }
  // Launch planning recognizes only bare launchers; the pane recognizer also reads commands with arguments.
  const recognized = resolveLaunchCommandPaneAgent(params.command)
  if (recognized && recognized !== params.commandAgent) {
    return contradictionRefusal(params.commandAgent, recognized)
  }
  return null
}
