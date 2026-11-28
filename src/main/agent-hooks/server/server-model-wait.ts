import type { AgentHookEventPayload } from '../../../shared/agent-hook-listener/listener-event'
import type { AgentHookSource } from '../../../shared/agent-hook-listener/transport/agent-hook-relay'
import { PaneTimers } from './program-status/pane-timers'
import { AgentHookServerIngestNormalization } from './server-ingest-normalization'
import type { NormalizedLocalHook } from './server-types'
import { isValidPaneKey, paneCacheKeyMatchesTab } from './server-status-identity'

/** Model time, the stopwatch Claude's hooks can keep: a turn is open, no lead tool runs, no one is asked. */
export type TerminalModelWait = {
  /** The pane's last hook: the stopwatch's start. */
  since: number
  turnKey: string
  /** A lead tool looks open, but this Claude never sent PostToolBatch, which closes tools whose
   *  PostToolUse never came (older Claude, or one long run): only the screen can say it still runs. */
  toolMaybeOpen: boolean
  /** False once a hook moved the stopwatch, or the turn ended, after this look began. */
  stillWaiting: () => boolean
  /** The screen shows a tool running: model time can only start after it. */
  toolSeenRunning: () => void
  /** The lead Claude's transcript, as its last hook named it. */
  transcriptPath?: string
  /** True once per stretch: a repeat look's notice is already in mail, so it needs no read. */
  firstTranscriptLook: () => boolean
}

export const TERMINAL_MODEL_WAIT_MS = 10 * 60_000

type PaneModelWait = {
  tools: Set<string>
  since: number
  turnKey: string
  /** The lead's Claude session: a nested `claude -p` in its Bash tool shares the pane key. */
  session?: string
  transcriptPath?: string
  /** The stretch (its `since`) whose transcript was read. */
  transcriptReadSince?: number
}

const TURN_ENDS = new Set(['Stop', 'StopFailure', 'SessionEnd'])
const TOOL_ENDS = new Set(['PostToolUse', 'PostToolUseFailure'])

/** Terminal Claude's model time, from its own hooks: every hook restarts one pane timer. When it
 *  runs out while the pane's row is working and no lead tool is open, the terminal lifecycle reads
 *  the screen, since Claude fires no hook while a reply streams. */
export abstract class AgentHookServerModelWait extends AgentHookServerIngestNormalization {
  private readonly modelWaits = new Map<string, PaneModelWait>()
  private readonly modelWaitTimers = new PaneTimers()
  /** Panes whose Claude has sent PostToolBatch: an open tool there is tool time, in every turn. */
  private readonly batchingPanes = new Set<string>()

  protected override normalizeLocalHookPayload(
    source: AgentHookSource,
    body: unknown,
    isReplay = false
  ): NormalizedLocalHook {
    const normalized = super.normalizeLocalHookPayload(source, body, isReplay)
    const { event } = normalized
    if (source !== 'claude' || !event?.hookEventName) {
      return normalized
    }
    const name = event.hookEventName
    // Only a hook the pane's status took: a nested CLI's refused Stop must not end the lead's turn.
    // A replay after a restart counts too: a request stalled across it sends no hook of its own.
    return {
      ...normalized,
      onAccepted: () => {
        normalized.onAccepted?.()
        this.observeModelWaitHook(event, name)
      }
    }
  }

  private observeModelWaitHook(event: AgentHookEventPayload, name: string): void {
    const paneKey = this.resolvePaneKeyAlias(event.paneKey)
    const lead = event.toolAgentId === undefined
    // A nested Claude run by the lead's open tool is that tool's work, not the lead's turn.
    if (this.fromNestedSession(paneKey, event)) {
      return
    }
    if (lead && TURN_ENDS.has(name)) {
      this.endModelWait(paneKey)
      if (name === 'SessionEnd') {
        this.batchingPanes.delete(paneKey)
      }
      return
    }
    const session = event.providerSession?.id
    const now = Date.now()
    // A subagent's or background task's hook after the turn ended opens no model time.
    if (!lead && !this.modelWaits.has(paneKey)) {
      return
    }
    const wait = this.startModelWait(paneKey, now)
    wait.since = now
    wait.session = session ?? wait.session
    if (lead) {
      wait.transcriptPath = event.providerSession?.transcriptPath ?? wait.transcriptPath
    }
    if (lead && name === 'UserPromptSubmit') {
      wait.tools.clear()
      wait.turnKey = `${paneKey}:${now}`
    } else if (lead && name === 'PreToolUse') {
      wait.tools.add(event.toolUseId ?? '')
    } else if (lead && TOOL_ENDS.has(name)) {
      if (event.toolUseId === undefined) {
        wait.tools.clear()
      } else {
        wait.tools.delete(event.toolUseId)
      }
    } else if (lead && name === 'PostToolBatch') {
      wait.tools.clear()
      this.batchingPanes.add(paneKey)
    }
  }

  /** A Claude turn restored working after a restart: a request stalled across it sends no hook. */
  protected override hydrateLastStatusFromDisk(): void {
    super.hydrateLastStatusFromDisk()
    const now = Date.now()
    for (const [paneKey, row] of this.state.lastStatusByPaneKey) {
      if (
        row.connectionId === null &&
        row.payload.agentType === 'claude' &&
        row.payload.state === 'working'
      ) {
        // A tool begun before the restart sent its PreToolUse to the old server: the screen decides.
        this.startModelWait(paneKey, now).tools.add('')
      }
    }
  }

  override transferPaneAuthority(
    ...args: Parameters<AgentHookServerIngestNormalization['transferPaneAuthority']>
  ): void {
    const [fromPaneKey, toPaneKey] = args
    // The owner the move takes the pane's state from, as the base resolves it.
    const from = this.resolvePaneKeyAlias(fromPaneKey)
    super.transferPaneAuthority(...args)
    if (from === toPaneKey || !isValidPaneKey(fromPaneKey) || !isValidPaneKey(toPaneKey)) {
      return
    }
    if (this.batchingPanes.delete(from)) {
      this.batchingPanes.add(toPaneKey)
    }
    const wait = this.modelWaits.get(from)
    if (!wait) {
      return
    }
    this.modelWaits.delete(from)
    this.modelWaits.set(toPaneKey, wait)
    this.modelWaitTimers.move(from, toPaneKey)
    // A wait whose timer already fired (its screen look still running) needs one at its new key.
    this.modelWaitTimers.deferUnlessPending(
      toPaneKey,
      wait.since + TERMINAL_MODEL_WAIT_MS - Date.now(),
      (key) => {
        void this.modelWaitElapsed(key)
      }
    )
  }

  // A pane's row cleared mid-turn (a tmux republish) keeps its wait; its timer drops one at rest.
  override dropStatusEntriesByTabPrefix(tabId: string): void {
    for (const paneKey of [...this.modelWaits.keys(), ...this.batchingPanes]) {
      if (paneCacheKeyMatchesTab(paneKey, tabId)) {
        this.endModelWait(paneKey)
        this.batchingPanes.delete(paneKey)
      }
    }
    super.dropStatusEntriesByTabPrefix(tabId)
  }

  protected clearModelWaits(): void {
    this.modelWaits.clear()
    this.modelWaitTimers.clear()
    this.batchingPanes.clear()
  }

  /** One timer per pane: a hook only moves `since`, and the timer finds the rest when it runs. */
  private startModelWait(paneKey: string, now: number): PaneModelWait {
    const wait = this.modelWaits.get(paneKey) ?? {
      tools: new Set<string>(),
      since: now,
      turnKey: `${paneKey}:${now}`
    }
    this.modelWaits.set(paneKey, wait)
    this.modelWaitTimers.deferUnlessPending(paneKey, TERMINAL_MODEL_WAIT_MS, (key) => {
      void this.modelWaitElapsed(key)
    })
    return wait
  }

  private endModelWait(paneKey: string): void {
    this.modelWaits.delete(paneKey)
    this.modelWaitTimers.cancel(paneKey)
  }

  private async modelWaitElapsed(paneKey: string): Promise<void> {
    const wait = this.modelWaits.get(paneKey)
    if (!wait) {
      return
    }
    const rearm = (delayMs: number) =>
      this.modelWaitTimers.deferUnlessPending(paneKey, delayMs, (key) => {
        void this.modelWaitElapsed(key)
      })
    const remaining = wait.since + TERMINAL_MODEL_WAIT_MS - Date.now()
    if (remaining > 0) {
      rearm(remaining)
      return
    }
    // Waiting on a person, or at rest: the next hook starts the stopwatch again.
    // A background task keeps the row working (monitoring) after the lead's turn is done.
    const status = this.state.lastStatusByPaneKey.get(paneKey)?.payload
    if (status?.state !== 'working' || status.workingMode === 'monitoring') {
      this.modelWaits.delete(paneKey)
      return
    }
    if (wait.tools.size > 0 && this.batchingPanes.has(paneKey)) {
      rearm(TERMINAL_MODEL_WAIT_MS)
      return
    }
    const { since } = wait
    const check = this.terminalPaneLifecycle?.modelWaitElapsed
    const keep = check
      ? await check(paneKey, {
          since,
          turnKey: wait.turnKey,
          toolMaybeOpen: wait.tools.size > 0,
          stillWaiting: () => this.modelWaits.get(paneKey) === wait && wait.since === since,
          toolSeenRunning: () => {
            wait.since = Date.now()
          },
          ...(wait.transcriptPath ? { transcriptPath: wait.transcriptPath } : {}),
          firstTranscriptLook: () => {
            const first = wait.transcriptReadSince !== wait.since
            wait.transcriptReadSince = wait.since
            return first
          }
        }).catch(() => false)
      : false
    if (this.modelWaits.get(paneKey) !== wait) {
      return
    }
    // No worker on the pane: nothing to tell anyone until its next hook.
    if (keep) {
      rearm(TERMINAL_MODEL_WAIT_MS)
    } else {
      this.modelWaits.delete(paneKey)
    }
  }

  private fromNestedSession(paneKey: string, event: AgentHookEventPayload): boolean {
    const known = this.modelWaits.get(paneKey)
    const session = event.providerSession?.id
    return Boolean(known?.session && session && session !== known.session && known.tools.size > 0)
  }
}
