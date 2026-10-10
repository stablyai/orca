import { pickSourceControlLaunchAgent } from '../../shared/source-control-launch-agent-selection'
import type { TuiAgent } from '../../shared/tui-agent'
import { isTuiAgent } from '../../shared/tui-agent-config'
import { ambiguousNameReply, resolveAgentBySpokenName } from './agent-name-resolution'
import {
  dispatchVoiceMessageToAgent,
  launchVoiceAgentInWorktree,
  type VoiceAgentLaunchDeps
} from './voice-control-agent-dispatch'
import { isClientLocalVoiceEntry, type VoiceRosterEntry } from './voice-control-roster'
import type { VoiceToolDispatchContext, VoiceToolResult } from './voice-control-tool-dispatch'

/**
 * message_agent and start_agent — the two ways work reaches an agent. Split from the main
 * dispatch (module size). message_agent drives a live pane; start_agent wakes an idle
 * worktree (a roster entry with no pane) by launching the agent with the dispatch
 * preamble as its startup prompt, so reply routing and watchdog follow-through are
 * identical to a messaged agent.
 */

type NameResolution =
  | { kind: 'resolved'; entry: VoiceRosterEntry }
  | { kind: 'explained'; result: VoiceToolResult }

function resolveOrExplain(roster: VoiceRosterEntry[], agentName: string): NameResolution {
  const resolution = resolveAgentBySpokenName(agentName, roster)
  if (resolution.kind === 'ambiguous') {
    return {
      kind: 'explained',
      result: { output: ambiguousNameReply(resolution.candidates) }
    }
  }
  if (resolution.kind === 'unresolved') {
    const live = roster.filter((entry) => entry.paneKey !== '')
    const idle = roster.filter((entry) => entry.paneKey === '')
    const known = [
      live.length > 0 ? `running agents: ${live.map((entry) => entry.spokenName).join(', ')}` : '',
      idle.length > 0 ? `idle worktrees: ${idle.map((entry) => entry.spokenName).join(', ')}` : ''
    ]
      .filter(Boolean)
      .join('; ')
    return {
      kind: 'explained',
      result: { output: `No agent or worktree matches "${agentName}". Known: ${known || 'none'}.` }
    }
  }
  return { kind: 'resolved', entry: resolution.entry }
}

export async function messageAgent(
  ctx: VoiceToolDispatchContext,
  agentName: string,
  message: string
): Promise<VoiceToolResult> {
  const roster = await ctx.refreshRoster()
  const resolved = resolveOrExplain(roster, agentName)
  if (resolved.kind === 'explained') {
    return resolved.result
  }
  const { entry } = resolved
  if (entry.paneKey === '') {
    return {
      output: `${entry.spokenName} is an idle worktree — no agent is running there. Use start_agent with the task to wake it.`,
      target: entry.spokenName
    }
  }
  // A mid-ceremony throw (e.g. the assignee's earlier dispatch never completed, so the
  // context store refuses a second one) must still become a tool output the model can
  // relay — a wedged function call reads to the model as "request sent" (live failure).
  let result: Awaited<ReturnType<typeof dispatchVoiceMessageToAgent>>
  try {
    result = await dispatchVoiceMessageToAgent(
      { ...ctx.dispatch, runId: ctx.runId() },
      entry,
      message
    )
  } catch (error) {
    return {
      output: `Could not dispatch to ${entry.spokenName}: ${error instanceof Error ? error.message : String(error)}. If that names an earlier dispatch that never settled, it is leftover bookkeeping — the agent itself is likely idle. Offer to clear the stale dispatch (the worker-show → worker-abandon flow) and retry.`,
      target: entry.spokenName
    }
  }
  if (result.kind === 'dispatched' || result.kind === 'dispatched-unobserved') {
    // The chip says "working on it" until the reply lands and is spoken, and the
    // watchdog owes the user follow-through on exactly this entry.
    ctx.recordDispatch(entry.paneKey, entry.spokenName, message)
    ctx.emitAgentActivity({
      sessionId: ctx.sessionId,
      paneKey: entry.paneKey,
      activity: 'thinking',
      spokenName: entry.spokenName
    })
  }
  switch (result.kind) {
    case 'dispatched':
      return {
        output: `Sent to ${entry.spokenName}. You stay on top of it: a report reaches you as a system note, and the watchdog flags it if the agent stalls or needs the user.`,
        target: entry.spokenName,
        silent: true
      }
    case 'dispatched-unobserved':
      return {
        output: `Sent to ${entry.spokenName}, though the send could not be confirmed.`,
        target: entry.spokenName,
        silent: true
      }
    case 'no-agent-detected':
      return {
        output: `${entry.spokenName}'s terminal has no agent running in it anymore — the pane is a bare shell and the roster entry was stale. Nothing was dispatched. Offer to start a fresh agent there with start_agent; do not retry message_agent until one is running.`,
        target: entry.spokenName
      }
    case 'unreachable':
      return {
        output: `${entry.spokenName} can't be reached right now (${result.reason}).`,
        target: entry.spokenName
      }
  }
}

export async function startAgent(
  ctx: VoiceToolDispatchContext,
  agentName: string,
  message: string,
  agentParam: string | null
): Promise<VoiceToolResult> {
  if (agentParam && !isTuiAgent(agentParam)) {
    return {
      output: `"${agentParam}" is not an agent CLI I know (claude, codex, gemini, …). Ask the user which agent they meant.`
    }
  }
  const explicitAgent = agentParam && isTuiAgent(agentParam) ? agentParam : null
  const roster = await ctx.refreshRoster()
  const resolved = resolveOrExplain(roster, agentName)
  if (resolved.kind === 'explained') {
    return resolved.result
  }
  // Already running: starting means messaging. Same ceremony, same follow-through.
  if (resolved.entry.paneKey !== '') {
    // …but the roster is stale-tolerant: a pane whose agent exited is a bare shell, and
    // "restart that agent" must LAUNCH, not message into the void. Same probe the
    // dispatch ceremony preflights with.
    const handle = ctx.dispatch.terminalHandleForPaneKey(resolved.entry.paneKey)
    const alive = handle ? await ctx.dispatch.runtime.isTerminalRunningAgent(handle) : false
    if (alive) {
      return messageAgent(ctx, agentName, message)
    }
  }
  return ctx.startAgentInWorktree(resolved.entry, message, explicitAgent)
}

/** The slice of the session backend startAgentInWorktree needs — keeps the backend under
 *  the module size cap without seam-less imports. */
export type VoiceStartAgentDeps = {
  launch: Omit<VoiceAgentLaunchDeps, 'runId'>
  runId: () => string
  /** The configured default agent — raw value; the shared picker handles 'blank'/null. */
  defaultLaunchAgent: () => TuiAgent | 'blank' | null
  disabledLaunchAgents: () => TuiAgent[]
  /** Installed agent CLI ids on this machine (preflight detection, cached). */
  detectInstalledAgents: () => Promise<string[]>
  /** True while a remote runtime drives this window — then every launch is host-side. */
  remoteRuntimeActive: () => boolean
  refreshRoster: () => Promise<VoiceRosterEntry[]>
  recordDispatch: (paneKey: string, spokenName: string, task: string) => void
}

export async function startVoiceAgentInWorktree(
  deps: VoiceStartAgentDeps,
  entry: VoiceRosterEntry,
  message: string,
  explicitAgent: TuiAgent | null
): Promise<VoiceToolResult> {
  // detectInstalledAgents scans THIS machine — it can neither vouch for nor rule out a
  // CLI on a remote host (ssh-execution-boundary: the execution host owns its tools).
  // The gate applies to client-local entries only; a remote launch's own error is the
  // honest signal there.
  const clientLocal = isClientLocalVoiceEntry(entry) && !deps.remoteRuntimeActive()
  let agent: TuiAgent | null
  if (explicitAgent) {
    if (clientLocal) {
      const installed = await deps.detectInstalledAgents()
      if (!installed.includes(explicitAgent)) {
        return {
          output: `${explicitAgent} isn't installed on this machine — installed agents: ${installed.join(', ') || 'none'}. Ask the user which of those to use.`,
          target: entry.spokenName
        }
      }
    }
    agent = explicitAgent
  } else {
    // The same precedence the new-workspace flow uses: worktree history, then the
    // configured default, then the curated auto-pick order over installed agents (the
    // installed list is client-local, so a remote pick goes on history + default alone).
    agent = pickSourceControlLaunchAgent({
      savedAgent: entry.createdWithAgent ?? null,
      defaultAgent: deps.defaultLaunchAgent(),
      detectedAgents: clientLocal ? (await deps.detectInstalledAgents()).filter(isTuiAgent) : [],
      disabledAgents: deps.disabledLaunchAgents()
    })
    if (!agent) {
      return {
        output: clientLocal
          ? `${entry.spokenName} has no running agent and no agent CLI is installed that I can start. Ask the user which agent to install or run there.`
          : `${entry.spokenName} is on a remote host and I can't see which agent CLIs are installed there — ask the user which agent to start.`,
        target: entry.spokenName
      }
    }
  }
  const result = await launchVoiceAgentInWorktree(
    { ...deps.launch, runId: deps.runId() },
    entry,
    agent,
    message
  )
  if (result.kind === 'unreachable') {
    return {
      output: `Starting an agent in ${entry.spokenName} failed: ${result.reason}`,
      target: entry.spokenName
    }
  }
  // Ledger: the pane registers under its own key once the PTY is live; one refresh
  // usually shows it. A miss leaves a synthetic key — the watchdog skips paneKeys it
  // cannot find, and the reply mail speaks regardless of the ledger.
  const roster = await deps.refreshRoster()
  const pane = roster.find(
    (candidate) => candidate.worktreeId === entry.worktreeId && candidate.paneKey !== ''
  )
  const paneKey = pane?.paneKey ?? `starting:${entry.worktreeId}`
  deps.recordDispatch(paneKey, entry.spokenName, message)
  return {
    output: `Started ${agent} in ${entry.spokenName} with the task. You stay on top of it: a report reaches you as a system note, and the watchdog flags it if the agent stalls or needs the user.`,
    target: entry.spokenName,
    silent: true
  }
}
