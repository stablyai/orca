import type {
  VoiceControlAgentActivityEvent,
  VoiceControlSettings,
  VoiceControlToolActivityEvent,
  VoiceScreenSnapshot,
  VoiceUiAction,
  VoiceUiActionResult
} from '../../shared/voice-control-types'
import type { VoiceAgentDispatchDeps, VoiceAgentLaunchDeps } from './voice-control-agent-dispatch'
import { startVoiceAgentInWorktree } from './voice-control-agent-tool-dispatch'
import type { RealtimeResponseGate } from './realtime-response-gate'
import {
  VoiceControlReplyPump,
  type ControlMailboxMessage,
  type VoiceControlReplyPumpDeps
} from './voice-control-reply-pump'
import { ReplySpeechSequencer } from './voice-control-reply-speech'
import { projectVoiceRoster, type VoiceRosterEntry } from './voice-control-roster'
import {
  runVoiceControlTool,
  type VoiceToolDispatchContext,
  type VoiceToolResult
} from './voice-control-tool-dispatch'
import {
  traceVoiceReplySettled,
  traceVoiceReplySpeak,
  traceVoiceToolDispatch
} from './voice-control-tracing'
import type { VoiceTranscriptEntry } from './voice-control-transcript-log'
import {
  computeWatchdogFindings,
  watchdogFindingKey,
  type OutstandingWorkItem
} from './voice-control-watchdog'
import type { RuntimeWorktreePsSummary } from '../../shared/runtime-worktree-contracts'
import type { TuiAgent } from '../../shared/tui-agent'

/**
 * The live-session backend: the coordinator's orchestration run, reply pump, voice
 * sequencer, watchdog, and command/transcript recording, behind the tool dispatches. The
 * service owns the realtime connection lifecycle; everything "do something in Orca"
 * happens here. The tool handlers themselves live in voice-control-tool-dispatch.ts.
 */

export type VoiceControlSessionBackend = {
  start: () => void
  dispatchToolCall: (name: string, argumentsJson: string, toolCallId: string) => Promise<void>
  observeEvent: (event: Record<string, unknown>) => void
  dispose: () => void
}

export type VoiceControlSessionBackendDeps = {
  sessionId: string
  gate: RealtimeResponseGate
  send: (event: Record<string, unknown>) => void
  getSettings: () => VoiceControlSettings
  getRoster: () => Promise<RuntimeWorktreePsSummary[]>
  dispatch: Omit<VoiceAgentDispatchDeps, 'runId'>
  /** start_agent's launch ceremony (terminal create + startup preamble), minus the run id. */
  launch: Omit<VoiceAgentLaunchDeps, 'runId'>
  /** start_agent's pick inputs: configured default, disabled list, installed detection. */
  defaultLaunchAgent: () => TuiAgent | 'blank' | null
  disabledLaunchAgents: () => TuiAgent[]
  detectInstalledAgents: () => Promise<string[]>
  openRun: () => { runId: string; mailboxHandle: string }
  pump: Omit<VoiceControlReplyPumpDeps, 'onMessages'>
  /** The coordinator's own workspace cwd for run_command when no agent is named. */
  defaultCwd: () => Promise<string>
  /** True while this window is driven by a remote runtime — client-local tools refuse. */
  remoteRuntimeActive: () => boolean
  /** The process runner — seam-injected so backend tests never spawn a real shell. */
  runCommandProcess: VoiceToolDispatchContext['runCommandProcess']
  focusPane: (messages: { channel: string; payload: Record<string, unknown> }[]) => void
  emitToolActivity: (event: VoiceControlToolActivityEvent) => void
  emitAgentActivity: (event: VoiceControlAgentActivityEvent) => void
  /** Durable transcript entries (durable log + live panel read the same feed). */
  recordTranscript: (entry: VoiceTranscriptEntry) => void
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

/** How often the watchdog re-checks outstanding work. Local roster reads; no API cost. */
const WATCHDOG_INTERVAL_MS = 60_000

export class VoiceControlSessionBackendImpl implements VoiceControlSessionBackend {
  private pump: VoiceControlReplyPump | null = null
  private sequencer: ReplySpeechSequencer | null = null
  private roster: VoiceRosterEntry[] = []
  /** Work the coordinator kicked off and owes follow-through on, keyed by pane. */
  private readonly outstanding = new Map<string, OutstandingWorkItem>()
  /** Watchdog findings already announced, `${paneKey}:${kind}` — each fires once. */
  private readonly notifiedFindings = new Set<string>()
  private watchdogTimer: ReturnType<typeof setInterval> | null = null
  private readonly commandAbort = new AbortController()
  private disposed = false

  constructor(private readonly deps: VoiceControlSessionBackendDeps) {}

  start(): void {
    const run = this.deps.openRun()
    this.activeRunId = run.runId
    this.sequencer = new ReplySpeechSequencer(
      this.deps.gate,
      () => this.deps.getSettings().agentVoiceMode === 'per-agent',
      (paneKey) => {
        traceVoiceReplySettled(paneKey)
        this.deps.emitAgentActivity({
          sessionId: this.deps.sessionId,
          paneKey,
          activity: 'idle'
        })
      }
    )
    this.pump = new VoiceControlReplyPump(
      { ...this.deps.pump, onMessages: (messages) => void this.handleMail(messages) },
      run.runId
    )
    this.pump.start()
    this.watchdogTimer = setInterval(() => void this.watchdogTick(), WATCHDOG_INTERVAL_MS)
    this.deps.emitToolActivity({
      sessionId: this.deps.sessionId,
      tool: 'orchestration',
      detail: `control run ${run.runId} listening on ${run.mailboxHandle}`
    })
  }

  observeEvent(event: Record<string, unknown>): void {
    this.sequencer?.observe(event)
  }

  dispose(): void {
    this.disposed = true
    this.commandAbort.abort()
    if (this.watchdogTimer) {
      clearInterval(this.watchdogTimer)
      this.watchdogTimer = null
    }
    this.pump?.stop()
    this.pump = null
    this.sequencer?.disarm()
    this.sequencer = null
  }

  async dispatchToolCall(name: string, argumentsJson: string, toolCallId: string): Promise<void> {
    // A throwing dispatch must still produce the function_call_output — the model's turn
    // hangs on it, and a wedged call reads to the model as success (live: message_agent
    // threw on an assignee's stale open dispatch; the coordinator later insisted "I've
    // already sent the request").
    const outcome = await runVoiceControlTool(this.toolContext(), name, argumentsJson).catch(
      (error: unknown): VoiceToolResult => ({
        output: `${name} failed: ${error instanceof Error ? error.message : String(error)}`
      })
    )
    const { output, target: resolvedTarget, silent, transcriptSummary } = outcome
    // The pill narrates the tool by name + resolved agent; the model-facing output
    // string is for the provider only, never for the UI.
    traceVoiceToolDispatch(name, resolvedTarget)
    this.deps.emitToolActivity({
      sessionId: this.deps.sessionId,
      tool: name,
      target: resolvedTarget
    })
    // Screen actions leave a durable line too — without it the log is blind to every
    // click the coordinator made on the user's behalf.
    if (transcriptSummary) {
      this.deps.recordTranscript({ ts: Date.now(), kind: 'ui', summary: transcriptSummary })
    }
    this.deps.gate.sendEvent({
      type: 'conversation.item.create',
      item: { type: 'function_call_output', call_id: toolCallId, output }
    })
    // A silent (successful) dispatch creates no follow-up response: the model acked before
    // calling the tool, and the next spoken thing should be the agent's reply itself.
    if (!silent) {
      this.deps.gate.sendEvent({ type: 'response.create' })
    }
  }

  private toolContext() {
    return {
      sessionId: this.deps.sessionId,
      runId: () => this.runId(),
      refreshRoster: () => this.refreshRoster(),
      dispatch: this.deps.dispatch,
      defaultCwd: this.deps.defaultCwd,
      remoteRuntimeActive: this.deps.remoteRuntimeActive,
      runCommandProcess: this.deps.runCommandProcess,
      commandSignal: () => this.commandAbort.signal,
      focusPane: this.deps.focusPane,
      emitAgentActivity: this.deps.emitAgentActivity,
      recordDispatch: (paneKey: string, spokenName: string, task: string) =>
        this.recordDispatch(paneKey, spokenName, task),
      startAgentInWorktree: (entry, message, explicitAgent) =>
        startVoiceAgentInWorktree(
          {
            launch: this.deps.launch,
            runId: () => this.runId(),
            defaultLaunchAgent: this.deps.defaultLaunchAgent,
            disabledLaunchAgents: this.deps.disabledLaunchAgents,
            detectInstalledAgents: this.deps.detectInstalledAgents,
            remoteRuntimeActive: this.deps.remoteRuntimeActive,
            refreshRoster: () => this.refreshRoster(),
            recordDispatch: (paneKey, spokenName, task) =>
              this.recordDispatch(paneKey, spokenName, task)
          },
          entry,
          message,
          explicitAgent
        ),
      recordCommand: (command: string, cwd: string, resultSummary: string) => {
        this.deps.recordTranscript({
          ts: Date.now(),
          kind: 'command',
          command,
          cwd,
          output: resultSummary
        })
      },
      describeScreen: this.deps.describeScreen,
      seeScreen: this.deps.seeScreen,
      performUiAction: this.deps.performUiAction,
      readTerminal: this.deps.readTerminal,
      openUrl: this.deps.openUrl
    }
  }

  /** The watchdog ledger write — one shape, used by message_agent and the launch ceremony. */
  private recordDispatch(paneKey: string, spokenName: string, task: string): void {
    this.outstanding.set(paneKey, { paneKey, spokenName, task, dispatchedAt: Date.now() })
  }

  private async handleMail(messages: ControlMailboxMessage[]): Promise<void> {
    for (const message of messages) {
      if (this.disposed) {
        return
      }
      const speaker = await this.resolveSpeaker(message)
      if (!speaker) {
        continue
      }
      // The reply IS the follow-through for that pane's outstanding work.
      this.outstanding.delete(speaker.paneKey)
      this.deps.emitAgentActivity({
        sessionId: this.deps.sessionId,
        paneKey: speaker.paneKey,
        activity: 'speaking',
        spokenName: speaker.spokenName
      })
      traceVoiceReplySpeak(speaker.paneKey, speaker.spokenName)
      this.deps.recordTranscript({
        ts: Date.now(),
        kind: 'update',
        spokenName: speaker.spokenName,
        text: message.body
      })
      this.sequencer?.speak({
        paneKey: speaker.paneKey,
        spokenName: speaker.spokenName,
        text: message.body,
        attribute: speaker.attribute
      })
    }
  }

  private async resolveSpeaker(
    message: ControlMailboxMessage
  ): Promise<{ paneKey: string; spokenName: string; attribute?: boolean } | null> {
    if (message.senderPaneKey) {
      const entry = this.roster.find((e) => e.paneKey === message.senderPaneKey)
      if (entry) {
        return entry
      }
      // The roster moved since the last tool call; refresh before giving up.
      const refreshed = await this.refreshRoster()
      const found = refreshed.find((e) => e.paneKey === message.senderPaneKey)
      if (found) {
        return found
      }
      return {
        paneKey: message.senderPaneKey,
        spokenName: message.senderPaneKey,
        attribute: false
      }
    }
    // Pane-less session mail: an update with no agent to name.
    return { paneKey: `run:${this.runId()}`, spokenName: 'update', attribute: false }
  }

  private async watchdogTick(): Promise<void> {
    if (this.disposed || this.outstanding.size === 0) {
      return
    }
    const roster = await this.refreshRoster()
    const findings = computeWatchdogFindings({
      outstanding: [...this.outstanding.values()],
      roster,
      notified: this.notifiedFindings
    })
    for (const finding of findings) {
      this.notifiedFindings.add(watchdogFindingKey(finding))
      if (finding.kind === 'done') {
        this.outstanding.delete(finding.paneKey)
      }
      this.deps.recordTranscript({
        ts: Date.now(),
        kind: 'update',
        spokenName: finding.spokenName,
        text: finding.detail
      })
      this.sequencer?.speak({
        paneKey: finding.paneKey,
        spokenName: finding.spokenName,
        text: finding.detail,
        attribute: false
      })
    }
  }

  private async refreshRoster(): Promise<VoiceRosterEntry[]> {
    this.roster = projectVoiceRoster(await this.deps.getRoster())
    return this.roster
  }

  private runId(): string {
    return this.activeRunId
  }

  /** Set in start(); stable for the session's life. */
  private activeRunId = ''
}
