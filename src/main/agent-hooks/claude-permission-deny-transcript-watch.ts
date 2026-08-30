import { promises as fs } from 'node:fs'
import { AGENT_STATUS_STALE_AFTER_MS, type AgentType } from '../../shared/agent-status-types'
import {
  isClaudeToolPermissionWait,
  type ClaudePermissionDenyInferenceRequest
} from '../../shared/claude-permission-deny-intent'
import { createTranscriptNativeWatcher } from '../native-chat/transcript-native-watcher'

/** Structural deny detection for local Claude panes: a denied tool never runs,
 *  so an `is_error` tool_result for the tool_use_id that requested permission
 *  can only appear in the session transcript when the user rejected it. An
 *  approved tool resumes through PreToolUse first, which replaces the waiting
 *  entry and invalidates the baseline. This does not depend on TUI wording.
 *  Delivery is fs.watch-driven only, no polling fallback: this is best-effort
 *  healing, so when the watch cannot bind or the filesystem never delivers
 *  events, the pane keeps the pre-existing behavior (cleared by the next
 *  prompt or staleness) instead of being polled for.
 *  Known limit: panes whose transcript this process cannot read (SSH remotes,
 *  WSL) keep the stuck waiting state until the next prompt or staleness. */

/** Coalesces fs.watch event bursts into one read. */
const FS_EVENT_TICK_DELAY_MS = 25
/** Grace for a racing PostToolUse* hook (approved tool failing fast) to land
 *  and replace the waiting entry before the inference is attempted. */
const DENY_SETTLE_MS = 1_500
/** Backscan window for waits hydrated after the deny was already written. */
const TRANSCRIPT_BACKSCAN_BYTES = 64 * 1024
const MAX_PENDING_LINE_CHARS = 512 * 1024

type EnrichedStatusEvent = {
  paneKey: string
  connectionId: string | null
  receivedAt: number
  stateStartedAt: number
  toolUseId?: string
  providerSession?: { transcriptPath?: string }
  providerSessionOnly?: boolean
  payload: { state: string; agentType?: AgentType; toolName?: string; prompt: string }
}

type DenyWatchHookServer = {
  subscribeEnrichedStatus(listener: (event: EnrichedStatusEvent) => void): () => void
  inferClaudePermissionDenied(request: ClaudePermissionDenyInferenceRequest): boolean
}

type DenyWatchOptions = {
  settleMs?: number
  now?: () => number
}

type PaneDenyWatcher = {
  baseline: ClaudePermissionDenyInferenceRequest
  stop: () => void
}

function transcriptLineIsDenyResult(line: string, toolUseId: string): boolean {
  if (!line.includes(toolUseId) || !line.includes('tool_result')) {
    return false
  }
  let entry: unknown
  try {
    entry = JSON.parse(line)
  } catch {
    return false
  }
  if (typeof entry !== 'object' || entry === null) {
    return false
  }
  const message = (entry as { message?: unknown }).message
  const content =
    typeof message === 'object' && message !== null
      ? (message as { content?: unknown }).content
      : undefined
  if (!Array.isArray(content)) {
    return false
  }
  return content.some(
    (item) =>
      typeof item === 'object' &&
      item !== null &&
      (item as { type?: unknown }).type === 'tool_result' &&
      (item as { tool_use_id?: unknown }).tool_use_id === toolUseId &&
      (item as { is_error?: unknown }).is_error === true
  )
}

export function installClaudePermissionDenyTranscriptWatch(
  server: DenyWatchHookServer,
  options: DenyWatchOptions = {}
): () => void {
  const settleMs = options.settleMs ?? DENY_SETTLE_MS
  const now = options.now ?? (() => Date.now())
  const watchers = new Map<string, PaneDenyWatcher>()

  const startWatcher = (event: EnrichedStatusEvent): void => {
    const transcriptPath = event.providerSession?.transcriptPath
    const toolUseId = event.toolUseId
    if (!transcriptPath || !toolUseId) {
      return
    }
    const baseline: ClaudePermissionDenyInferenceRequest = {
      paneKey: event.paneKey,
      baselineUpdatedAt: event.receivedAt,
      baselineStateStartedAt: event.stateStartedAt,
      baselinePrompt: event.payload.prompt,
      baselineAgentType: event.payload.agentType
    }
    const deadline = event.receivedAt + AGENT_STATUS_STALE_AFTER_MS
    let stopped = false
    let ticking = false
    let fsEventDuringTick = false
    let offset: number | null = null
    let pendingLine = ''
    let pollTimer: ReturnType<typeof setTimeout> | null = null
    let settleTimer: ReturnType<typeof setTimeout> | null = null

    const stop = (): void => {
      stopped = true
      nativeWatcher.dispose()
      if (pollTimer !== null) {
        clearTimeout(pollTimer)
        pollTimer = null
      }
      if (settleTimer !== null) {
        clearTimeout(settleTimer)
        settleTimer = null
      }
      if (watchers.get(event.paneKey)?.stop === stop) {
        watchers.delete(event.paneKey)
      }
    }

    const scheduleTick = (delayMs: number): void => {
      if (stopped || settleTimer !== null) {
        return
      }
      if (pollTimer !== null) {
        clearTimeout(pollTimer)
      }
      pollTimer = setTimeout(() => void tick(), delayMs)
    }

    // Why: a watch error invalidates the binding; the scheduled tick reads any
    // missed growth, then rebinds or stops in its tail.
    const nativeWatcher = createTranscriptNativeWatcher(
      transcriptPath,
      () => {
        if (ticking) {
          fsEventDuringTick = true
          return
        }
        scheduleTick(FS_EVENT_TICK_DELAY_MS)
      },
      () => scheduleTick(FS_EVENT_TICK_DELAY_MS)
    )

    const settleThenInfer = (): void => {
      if (pollTimer !== null) {
        clearTimeout(pollTimer)
        pollTimer = null
      }
      // Why: the server re-validates the baseline, so a hook that landed during
      // the settle window (approved tool resuming/failing) wins over this path.
      settleTimer = setTimeout(() => {
        const applied = server.inferClaudePermissionDenied(baseline)
        console.debug('[agent-hooks] transcript deny watch settled', {
          paneKey: event.paneKey,
          applied
        })
        stop()
      }, settleMs)
    }

    const scanLines = (lines: string[]): boolean =>
      lines.some((line) => transcriptLineIsDenyResult(line, toolUseId))

    const tick = async (): Promise<void> => {
      if (stopped || ticking) {
        return
      }
      ticking = true
      try {
        const stat = await fs.stat(transcriptPath)
        if (offset === null || stat.size < offset) {
          // First look (or truncation): backscan the tail for a deny that was
          // written before this watch started, e.g. a wait hydrated after restart.
          const start = Math.max(0, stat.size - TRANSCRIPT_BACKSCAN_BYTES)
          const backscan = await readTranscriptRange(transcriptPath, start, stat.size)
          offset = stat.size
          pendingLine = ''
          // Drop the first line: it may be cut by the backscan window.
          if (scanLines(backscan.split('\n').slice(start > 0 ? 1 : 0))) {
            settleThenInfer()
            return
          }
        } else if (stat.size > offset) {
          const appended = await readTranscriptRange(transcriptPath, offset, stat.size)
          offset = stat.size
          const lines = (pendingLine + appended).split('\n')
          pendingLine = (lines.pop() ?? '').slice(-MAX_PENDING_LINE_CHARS)
          if (scanLines(lines)) {
            settleThenInfer()
            return
          }
        }
      } catch {
        // Unreadable transcript (still flushing, WSL path, permissions): keep
        // polling until the deadline.
      } finally {
        ticking = false
      }
      if (!stopped && settleTimer === null) {
        if (now() > deadline) {
          stop()
          return
        }
        // Why: without a binding no further signal can arrive — release the
        // pane to its pre-existing behavior rather than poll.
        if (nativeWatcher.needsRebind() && !nativeWatcher.bind()) {
          stop()
          return
        }
        if (fsEventDuringTick) {
          fsEventDuringTick = false
          scheduleTick(FS_EVENT_TICK_DELAY_MS)
        }
      }
    }

    watchers.set(event.paneKey, { baseline, stop })
    // Why: bind before the backscan so growth between the two cannot slip past
    // both; a failed bind falls through to the first tick's tail and stops.
    nativeWatcher.bind()
    void tick()
  }

  const unsubscribe = server.subscribeEnrichedStatus((event) => {
    if (event.providerSessionOnly === true) {
      return
    }
    const active = watchers.get(event.paneKey)
    if (active && event.receivedAt === active.baseline.baselineUpdatedAt) {
      return
    }
    active?.stop()
    // Why: only local panes — this process cannot read a remote transcript.
    if (event.connectionId === null && isClaudeToolPermissionWait(event.payload)) {
      startWatcher(event)
    }
  })

  return () => {
    unsubscribe()
    for (const watcher of watchers.values()) {
      watcher.stop()
    }
  }
}

async function readTranscriptRange(path: string, start: number, end: number): Promise<string> {
  const handle = await fs.open(path, 'r')
  try {
    const length = end - start
    const buffer = Buffer.alloc(length)
    const { bytesRead } = await handle.read(buffer, 0, length, start)
    return buffer.subarray(0, bytesRead).toString('utf8')
  } finally {
    await handle.close()
  }
}
