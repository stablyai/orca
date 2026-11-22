import type { AgentHookEventPayload } from '../../../shared/agent-hook-listener/listener-event'
import type { AgentHookSource } from '../../../shared/agent-hook-listener/transport/agent-hook-relay'
import { PaneTimers } from './program-status/pane-timers'
import { AgentHookServerIngestNormalization } from './server-ingest-normalization'
import type { NormalizedLocalHook } from './server-types'

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
}

export const TERMINAL_MODEL_WAIT_MS = 10 * 60_000

type PaneModelWait = {
  tools: Set<string>
  batches: boolean
  since: number
  turnKey: string
  /** The lead's Claude session: a nested `claude -p` in its Bash tool shares the pane key. */
  session?: string
}

const TURN_ENDS = new Set(['Stop', 'StopFailure', 'SessionEnd'])
const TOOL_ENDS = new Set(['PostToolUse', 'PostToolUseFailure'])

/** Terminal Claude's model time, from its own hooks: every hook restarts one pane timer. When it
 *  runs out while the pane's row is working and no lead tool is open, the terminal lifecycle reads
 *  the screen, since Claude fires no hook while a reply streams. */
export abstract class AgentHookServerModelWait extends AgentHookServerIngestNormalization {
  private readonly modelWaits = new Map<string, PaneModelWait>()
  private readonly modelWaitTimers = new PaneTimers()

  protected override normalizeLocalHookPayload(
    source: AgentHookSource,
    body: unknown,
    isReplay = false
  ): NormalizedLocalHook {
    const normalized = super.normalizeLocalHookPayload(source, body, isReplay)
    const { event } = normalized
    if (source !== 'claude' || isReplay || !event?.hookEventName) {
      return normalized
    }
    const name = event.hookEventName
    // Only a hook the pane's status took: a nested CLI's refused Stop must not end the lead's turn.
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
      this.modelWaits.delete(paneKey)
      this.modelWaitTimers.cancel(paneKey)
      return
    }
    const session = event.providerSession?.id
    const now = Date.now()
    const wait = this.modelWaits.get(paneKey) ?? {
      tools: new Set<string>(),
      batches: false,
      since: now,
      turnKey: `${paneKey}:${now}`
    }
    this.modelWaits.set(paneKey, wait)
    wait.since = now
    wait.session = session ?? wait.session
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
      wait.batches = true
    }
    // One timer per pane: a hook only moves `since`, and the timer finds the rest when it runs.
    this.modelWaitTimers.deferUnlessPending(paneKey, TERMINAL_MODEL_WAIT_MS, (key) => {
      void this.modelWaitElapsed(key)
    })
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
    if (this.state.lastStatusByPaneKey.get(paneKey)?.payload.state !== 'working') {
      this.modelWaits.delete(paneKey)
      return
    }
    if (wait.tools.size > 0 && wait.batches) {
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
