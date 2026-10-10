import {
  BROADCAST_TOOL_NAME,
  CLICK_ELEMENT_TOOL_NAME,
  DESCRIBE_SCREEN_TOOL_NAME,
  LIST_AGENTS_TOOL_NAME,
  MESSAGE_AGENT_TOOL_NAME,
  NAVIGATE_UI_TOOL_NAME,
  OPEN_URL_TOOL_NAME,
  READ_TERMINAL_TOOL_NAME,
  RUN_COMMAND_TOOL_NAME,
  SEE_SCREEN_TOOL_NAME,
  START_AGENT_TOOL_NAME,
  TYPE_INTO_TOOL_NAME,
  VOICE_NAVIGATE_VERBS,
  type VoiceControlAgentActivityEvent,
  type VoiceNavigateVerb,
  type VoiceScreenSnapshot,
  type VoiceUiAction,
  type VoiceUiActionResult
} from '../../shared/voice-control-types'
import type { TuiAgent } from '../../shared/tui-agent'
import { ambiguousNameReply, resolveAgentBySpokenName } from './agent-name-resolution'
import {
  dispatchVoiceMessageToAgent,
  type VoiceAgentDispatchDeps
} from './voice-control-agent-dispatch'
import { messageAgent, startAgent } from './voice-control-agent-tool-dispatch'
import { formatVoiceCommandOutput, type VoiceCommandResult } from './voice-control-command-runner'
import { isVoiceNavigateVerb, navigateSurfaceForVerb } from './voice-control-navigation'
import { buildAgentPaneFocusMessages } from './voice-control-pane-focus'
import {
  formatVoiceRosterForInstructions,
  isClientLocalVoiceEntry,
  type VoiceRosterEntry
} from './voice-control-roster'
import { runVoiceScreenTool } from './voice-control-screen-tool-dispatch'
import { parseToolArguments, readStringArg } from './voice-control-tool-arguments'

/**
 * The coordinator's tool handlers. Split from the session backend (module size); the
 * backend owns the run/pump/sequencer lifecycle and calls runVoiceControlTool for every
 * dispatched tool call. `output` is model-facing only (the provider reads it); `target`
 * is the resolved agent's spoken name so the renderer can narrate the dispatch.
 */

export type VoiceToolResult = {
  output: string
  target?: string
  /**
   * One-ack contract: the model acknowledged the request before dispatching, so a
   * successful dispatch creates no follow-up response — the next spoken thing is the
   * reply itself. Errors, roster answers, and command output still respond.
   */
  silent?: boolean
  /**
   * One line for the durable transcript/panel when the tool touched the UI (screen reads,
   * clicks, typed text) — set by the screen-tool dispatch; the session backend records it.
   */
  transcriptSummary?: string
}

export type VoiceToolDispatchContext = {
  sessionId: string
  runId: () => string
  refreshRoster: () => Promise<VoiceRosterEntry[]>
  dispatch: Omit<VoiceAgentDispatchDeps, 'runId'>
  /** The coordinator's own workspace cwd for run_command when no agent is named. */
  defaultCwd: () => Promise<string>
  /** True while this window is driven by a remote runtime — every roster row is then on
   *  the remote host, so client-local tools (run_command) must refuse outright. */
  remoteRuntimeActive: () => boolean
  /** The process runner — seam-injected so dispatch tests never spawn a real shell. */
  runCommandProcess: (options: {
    command: string
    cwd: string
    signal?: AbortSignal
  }) => Promise<VoiceCommandResult>
  /** Aborted on session stop; in-flight commands die with the session. */
  commandSignal: () => AbortSignal
  focusPane: (messages: { channel: string; payload: Record<string, unknown> }[]) => void
  emitAgentActivity: (event: VoiceControlAgentActivityEvent) => void
  /** The watchdog ledger: work the coordinator kicked off and owes the user follow-through on. */
  recordDispatch: (paneKey: string, spokenName: string, task: string) => void
  /** start_agent's wake path: launch the agent in an idle worktree with the task as its
   *  startup dispatch. The session backend owns the ceremony + ledger. */
  startAgentInWorktree: (
    entry: VoiceRosterEntry,
    message: string,
    explicitAgent: TuiAgent | null
  ) => Promise<VoiceToolResult>
  /** The transcript surface: one entry per command run, with its result. */
  recordCommand: (command: string, cwd: string, resultSummary: string) => void
  /** describe_screen's renderer round-trip; null when the owner window can't answer. */
  describeScreen: () => Promise<VoiceScreenSnapshot | null>
  /** see_screen's CDP snapshot of the owner window; null when the debugger can't attach. */
  seeScreen: () => Promise<string | null>
  /** click_element / type_into against see_screen refs; null when the screen is gone. */
  performUiAction: (action: VoiceUiAction) => Promise<VoiceUiActionResult | null>
  /** read_terminal: the visible text of the terminal pane(s) on screen. */
  readTerminal: () => Promise<string | null>
  /** open_url: a foreground browser tab at the URL in the user's window; throws the reason. */
  openUrl: (url: string) => Promise<void>
}

export async function runVoiceControlTool(
  ctx: VoiceToolDispatchContext,
  name: string,
  argumentsJson: string
): Promise<VoiceToolResult> {
  const args = parseToolArguments(argumentsJson)
  switch (name) {
    case LIST_AGENTS_TOOL_NAME: {
      const roster = await ctx.refreshRoster()
      return { output: formatVoiceRosterForInstructions(roster) }
    }
    case RUN_COMMAND_TOOL_NAME: {
      const command = readStringArg(args, 'command')
      if (!command) {
        return {
          output: 'The run_command call was missing the command; ask the user to repeat it.'
        }
      }
      return runCommand(ctx, command, readStringArg(args, 'agent'))
    }
    case MESSAGE_AGENT_TOOL_NAME: {
      const agentName = readStringArg(args, 'name')
      const message = readStringArg(args, 'message')
      if (!agentName || !message) {
        return {
          output: 'The message_agent call was missing a name or message; ask the user to repeat it.'
        }
      }
      return messageAgent(ctx, agentName, message)
    }
    case START_AGENT_TOOL_NAME: {
      const agentName = readStringArg(args, 'name')
      const message = readStringArg(args, 'message')
      if (!agentName || !message) {
        return {
          output:
            'The start_agent call was missing a name or the task message; ask the user to repeat what the agent should do.'
        }
      }
      return startAgent(ctx, agentName, message, readStringArg(args, 'agent'))
    }
    case BROADCAST_TOOL_NAME: {
      const message = readStringArg(args, 'message')
      if (!message) {
        return { output: 'The broadcast call was missing a message; ask the user to repeat it.' }
      }
      return broadcast(ctx, message)
    }
    case DESCRIBE_SCREEN_TOOL_NAME:
    case SEE_SCREEN_TOOL_NAME:
    case CLICK_ELEMENT_TOOL_NAME:
    case TYPE_INTO_TOOL_NAME:
    case READ_TERMINAL_TOOL_NAME:
      return runVoiceScreenTool(ctx, name, args)
    case NAVIGATE_UI_TOOL_NAME: {
      const verb = readStringArg(args, 'verb')
      if (!verb || !isVoiceNavigateVerb(verb)) {
        return {
          output: `The navigate_ui call was missing a known verb (${VOICE_NAVIGATE_VERBS.join(', ')}); ask the user what to show.`
        }
      }
      return navigateUi(ctx, verb, readStringArg(args, 'agent'))
    }
    case OPEN_URL_TOOL_NAME: {
      const url = readStringArg(args, 'url')
      if (!url) {
        return { output: 'The open_url call was missing the URL; ask the user to repeat it.' }
      }
      return openUrl(ctx, url)
    }
    default:
      return { output: `Unknown tool: ${name}` }
  }
}

async function runCommand(
  ctx: VoiceToolDispatchContext,
  command: string,
  agentName: string | null
): Promise<VoiceToolResult> {
  if (ctx.remoteRuntimeActive()) {
    // Every roster row is on the remote host then; a local spawn answers for nothing
    // the user is looking at (ssh-execution-boundary: never substitute the client).
    return {
      output:
        'run_command runs on this machine, but this window is currently driven by a remote runtime — everything on screen is on another host. Use message_agent to have an agent there run it.'
    }
  }
  let cwd: string | null = null
  let target: string | undefined
  if (agentName) {
    const roster = await ctx.refreshRoster()
    const resolution = resolveAgentBySpokenName(agentName, roster)
    if (resolution.kind === 'ambiguous') {
      return { output: ambiguousNameReply(resolution.candidates) }
    }
    if (resolution.kind === 'unresolved') {
      return {
        output: `No running agent matches "${agentName}". Known agents: ${roster.map((r) => r.spokenName).join(', ') || 'none'}.`
      }
    }
    if (!isClientLocalVoiceEntry(resolution.entry)) {
      return {
        output: `${resolution.entry.spokenName} is on a remote host, and run_command only runs on this machine — a local run would answer for the wrong repository. Use message_agent to have the agent there run it.`,
        target: resolution.entry.spokenName
      }
    }
    cwd = resolution.entry.worktreePath
    target = resolution.entry.spokenName
  }
  cwd ??= await ctx.defaultCwd()
  const result = await ctx.runCommandProcess({ command, cwd, signal: ctx.commandSignal() })
  const output = formatVoiceCommandOutput(result)
  ctx.recordCommand(command, cwd, output)
  return { output: `\`${command}\` (in ${cwd}):\n${output}`, target }
}

async function broadcast(ctx: VoiceToolDispatchContext, message: string): Promise<VoiceToolResult> {
  const roster = await ctx.refreshRoster()
  if (roster.length === 0) {
    return { output: 'No agents are running, so the broadcast went nowhere.' }
  }
  // Each dispatch is independent (distinct handles and rows) — run them together; the
  // model's turn hangs on this tool's output, so N agents must not cost N × one dispatch.
  const results = await Promise.all(
    roster.map((entry) =>
      dispatchVoiceMessageToAgent({ ...ctx.dispatch, runId: ctx.runId() }, entry, message)
    )
  )
  const sentTo: string[] = []
  const failed: string[] = []
  roster.forEach((entry, index) => {
    if (results[index]?.kind === 'unreachable') {
      failed.push(entry.spokenName)
      return
    }
    sentTo.push(entry.spokenName)
    ctx.recordDispatch(entry.paneKey, entry.spokenName, message)
    ctx.emitAgentActivity({
      sessionId: ctx.sessionId,
      paneKey: entry.paneKey,
      activity: 'thinking',
      spokenName: entry.spokenName
    })
  })
  const failedPart = failed.length > 0 ? ` Could not reach ${failed.join(' or ')}.` : ''
  return {
    output: `Broadcast sent to ${sentTo.join(', ')}.${failedPart} Reports reach you as system notes.`,
    // A partial failure must be spoken; a clean broadcast is covered by the ack.
    silent: failed.length === 0
  }
}

/**
 * open_url: validate before touching the runtime — a voice-transcribed "URL" is often not
 * one, and only web pages may be opened (mirrors browserOpenUrlOnClient's guard). Failures
 * name the reason; never a bare "that didn't work".
 */
async function openUrl(ctx: VoiceToolDispatchContext, url: string): Promise<VoiceToolResult> {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return {
      output: `"${url}" is not a readable URL — read back the exact address you mean and retry with it.`
    }
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return {
      output: `Only web pages (http/https) open on screen — "${url}" is ${parsed.protocol}//.`
    }
  }
  try {
    await ctx.openUrl(url)
  } catch (error) {
    return {
      output: `Could not open that page: ${error instanceof Error ? error.message : String(error)}`
    }
  }
  return {
    output: `Done — opened ${url} in a browser tab on the user's screen.`,
    target: parsed.host,
    transcriptSummary: `Opened ${url}.`
  }
}

async function navigateUi(
  ctx: VoiceToolDispatchContext,
  verb: VoiceNavigateVerb,
  agentName: string | null
): Promise<VoiceToolResult> {
  if (verb !== 'focus-agent') {
    // A surface verb: send the channel the renderer already obeys for shortcuts/menus.
    const surface = navigateSurfaceForVerb(verb)
    ctx.focusPane([{ channel: surface.channel, payload: {} }])
    return { output: `Done — ${surface.past}.`, target: surface.target }
  }
  if (!agentName) {
    return { output: 'focus-agent needs the agent name; ask the user which agent.' }
  }
  const roster = await ctx.refreshRoster()
  const resolution = resolveAgentBySpokenName(agentName, roster)
  if (resolution.kind === 'ambiguous') {
    return { output: ambiguousNameReply(resolution.candidates) }
  }
  if (resolution.kind === 'unresolved') {
    return { output: `No running agent matches "${agentName}".` }
  }
  const messages = buildAgentPaneFocusMessages(resolution.entry)
  if (!messages) {
    return {
      output: `Could not focus ${resolution.entry.spokenName}; its pane id is unreadable.`
    }
  }
  ctx.focusPane(messages)
  return {
    output: `Brought ${resolution.entry.spokenName}'s pane forward.`,
    target: resolution.entry.spokenName
  }
}
