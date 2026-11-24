import type { AcpItemOwnership } from './acp-item-ownership'
import { z } from 'zod'
import type { AgentJournalToolCallItem } from '../../../shared/agent-session/journal/agent-session-journal-types'
import {
  boundToolInput,
  JOURNAL_RUNNING_PREVIEW_LIMITS,
  journalPayload,
  journalToolPayload
} from '../../native-chat/agent-session-journal/item-lifecycle/journal-payload-bounds'
import type {
  ProviderTimelineEvent,
  ProviderTimelineJoin
} from '../../native-chat/agent-session-timeline/provider-timeline-event'
import { boundedPatch } from '../../native-chat/agent-session-timeline/provider-timeline-bounded-patch'
import { BoundedMap } from '../../../shared/collections/bounded-map'
import type { AcpBackgroundTaskUpdate, AcpDialect } from '../acp-dialects/acp-dialect'
import type { ToolCallUpdate } from '../generated/acp-protocol.generated'
import { nativeChatToolImageReadPath } from '../../../shared/native-chat/tools/native-chat-tool-viewed-images'
import { acpToolImagePaths } from './acp-tool-images'

const rawStreamsSchema = z.object({ stdout: z.string().optional(), stderr: z.string().optional() })
const rawExitCodeSchema = z.looseObject({ exitCode: z.number().int().safe() })
const commandInputSchema = z.looseObject({ command: z.string().trim().min(1) })
const BACKGROUND_REPORT_MAX_CHARS = 500

function outputText(update: ToolCallUpdate): string | undefined {
  const text = update.content?.flatMap((block) =>
    block.type === 'content' && block.content.type === 'text' ? [block.content.text] : []
  )
  if (text?.length) {
    return text.join('\n')
  }
  if (update.rawOutput === undefined) {
    return undefined
  }
  if (typeof update.rawOutput === 'string') {
    return update.rawOutput
  }
  const streams = rawStreamsSchema.safeParse(update.rawOutput)
  if (streams.success && (streams.data.stdout !== undefined || streams.data.stderr !== undefined)) {
    return [streams.data.stdout, streams.data.stderr]
      .filter((value) => value !== undefined)
      .join('\n')
  }
  return JSON.stringify(update.rawOutput) ?? ''
}

// A pending call is waiting to start, often on a person's approval.
type ToolSnapshot = { body: AgentJournalToolCallItem; turn?: string; pending?: true }

// Keep partial-update context until completion or the owning turn ends.
export class AcpToolTimeline {
  private readonly tools = new Map<string, ToolSnapshot>()
  // Closing updates may omit fields; only their running journal copies are previews.
  private readonly whole = new Map<string, { input?: unknown; output?: string }>()
  // Kept after the task settles: its row is still Orca's inference, and settled reports latch.
  private readonly backgrounded = new BoundedMap<string, AcpBackgroundTaskUpdate | true>({
    maxEntries: 128
  })
  // Ownership remembers only the latest ended turn; late updates may name older calls.
  private readonly endedCalls = new BoundedMap<string, true>({ maxEntries: 512 })

  private storeImages = true

  constructor(private readonly owners: AcpItemOwnership) {}

  skipImageStore(): void {
    this.storeImages = false
  }

  /** Close the turn's running calls as launched; each continues as a background task. The call
   *  row reads completed because the call itself returned (agy answers it with "running as a
   *  background task"), and a settled call row cannot be revised; the task row carries the run's
   *  outcome. */
  background(
    turn: string,
    join: ProviderTimelineJoin
  ): { events: ProviderTimelineEvent[]; tasks: AcpBackgroundTaskUpdate[] } {
    const events: ProviderTimelineEvent[] = []
    const tasks: AcpBackgroundTaskUpdate[] = []
    for (const [callId, snapshot] of this.tools) {
      if (snapshot.turn !== turn || snapshot.pending) {
        continue
      }
      const input = this.whole.get(callId)?.input ?? snapshot.body.input
      this.tools.delete(callId)
      this.whole.delete(callId)
      this.backgrounded.set(callId, true)
      const command = commandInputSchema.safeParse(input).data?.command
      events.push({
        type: 'item.close',
        item: `tool:${callId}`,
        body: { ...snapshot.body, input, state: 'completed' },
        join: { ...join, scopeItems: [`tool:${callId}`] }
      })
      tasks.push({
        taskId: callId,
        state: 'working',
        parentToolUseId: callId,
        fallbackLabel: command ?? snapshot.body.name,
        fallbackKind: command ? 'command' : 'unknown'
      })
    }
    return { events, tasks }
  }

  /** A running call the earlier app saved: this run's updates to it revise what was saved. */
  carry(saved: AgentJournalToolCallItem, turn: string | undefined): void {
    const { callId } = saved
    if (callId === undefined || saved.state !== 'running' || this.tools.has(callId)) {
      return
    }
    this.tools.set(callId, { body: saved, ...(turn === undefined ? {} : { turn }) })
    if (turn !== undefined) {
      this.owners.remember(`tool:${callId}`, turn)
    }
  }

  /** The call with its whole input; a running journal copy holds only a preview. */
  wholeCall(toolCallId: string, body: AgentJournalToolCallItem): AgentJournalToolCallItem {
    const input = this.whole.get(toolCallId)?.input
    return input === undefined ? body : { ...body, input }
  }

  /** Orca inferred this task from a call still running at its turn's end. */
  backgrounds(toolCallId: string): boolean {
    return this.backgrounded.has(toolCallId)
  }

  /** The call belongs to a turn that already ended. */
  ended(toolCallId: string): boolean {
    return (
      this.backgrounded.has(toolCallId) ||
      this.endedCalls.has(toolCallId) ||
      this.turn(toolCallId) !== undefined
    )
  }

  /** A backgrounded call's later updates report its task instead of the closed call. */
  backgroundTask(
    raw: ToolCallUpdate,
    dialect: AcpDialect,
    at: number
  ): AcpBackgroundTaskUpdate | undefined {
    const held = this.backgrounded.get(raw.toolCallId)
    if (held !== true) {
      return held
    }
    const update = dialect.normalizeToolUpdate?.(raw) ?? raw
    if (update.status !== 'completed' && update.status !== 'failed') {
      return { taskId: update.toolCallId, state: 'working' }
    }
    const exitCode = rawExitCodeSchema.safeParse(update.rawOutput).data?.exitCode
    const failed = update.status === 'failed' || (exitCode !== undefined && exitCode !== 0)
    const report = outputText(update)?.trim().slice(-BACKGROUND_REPORT_MAX_CHARS)
    const settled: AcpBackgroundTaskUpdate = {
      taskId: update.toolCallId,
      state: failed ? 'blocked' : 'done',
      settledAt: at,
      ...(report ? (failed ? { error: report } : { summary: report }) : {})
    }
    this.backgrounded.set(update.toolCallId, settled)
    return settled
  }

  join(toolCallId: string): ProviderTimelineJoin {
    const turn = this.turn(toolCallId)
    return { ...(turn === undefined ? {} : { turn }), scopeItems: [`tool:${toolCallId}`] }
  }

  translate(
    raw: ToolCallUpdate,
    dialect: AcpDialect,
    join: ProviderTimelineJoin
  ): ProviderTimelineEvent[] {
    join = { ...join, ...this.join(raw.toolCallId), ...(join.turn ? { turn: join.turn } : {}) }
    const turn = join.turn
    // Thread-scoped calls have no owning turn to end them, so they keep context until completion.
    const retain =
      turn === undefined
        ? join.scope === undefined || join.scope.kind === 'thread'
        : this.owners.isLive(turn)
    const update = dialect.normalizeToolUpdate?.(raw) ?? raw
    const previous = this.tools.get(update.toolCallId)
    const held = this.whole.get(update.toolCallId)
    const input = update.rawInput === undefined ? held?.input : update.rawInput
    const suppliedOutput = outputText(update)
    const output = suppliedOutput ?? held?.output
    const exitCode = rawExitCodeSchema.safeParse(update.rawOutput).data?.exitCode
    const state =
      update.status === 'completed'
        ? 'completed'
        : update.status === 'failed'
          ? 'failed'
          : update.status === 'pending' || update.status === 'in_progress'
            ? 'running'
            : (previous?.body.state ?? 'running')
    if (state === 'running' && retain) {
      this.whole.set(update.toolCallId, { input, output })
    } else {
      this.whole.delete(update.toolCallId)
    }
    const body: AgentJournalToolCallItem = {
      kind: 'tool-call',
      callId: update.toolCallId,
      name:
        dialect.toolName?.(update) ??
        update.name ??
        previous?.body.name ??
        update.title ??
        update.kind ??
        'tool',
      input:
        input === undefined
          ? (previous?.body.input ?? null)
          : state === 'running'
            ? update.rawInput === undefined && previous
              ? previous.body.input
              : boundToolInput(input, JOURNAL_RUNNING_PREVIEW_LIMITS)
            : input,
      state,
      ...(exitCode === undefined ? {} : { exitCode }),
      ...(output === undefined
        ? previous?.body.output
          ? { output: previous.body.output }
          : {}
        : {
            output:
              state === 'running' && suppliedOutput === undefined && previous?.body.output
                ? previous.body.output
                : journalToolPayload(output, state === 'running')
          })
    }
    // Content replaces the call's snapshot; an update without it keeps the images it had.
    // A read's file already previews by its path.
    const imagePaths =
      update.content == null
        ? previous?.body.outputImagePaths
        : this.storeImages && nativeChatToolImageReadPath(body) === null
          ? acpToolImagePaths(update.content)
          : undefined
    if (imagePaths?.length) {
      body.outputImagePaths = imagePaths
    }
    if (turn !== undefined) {
      this.owners.remember(`tool:${update.toolCallId}`, turn)
    }
    const snapshot = {
      body,
      ...(turn === undefined ? {} : { turn }),
      // Status-less partial updates keep the call's approval wait.
      ...(update.status === 'pending' || (update.status == null && previous?.pending)
        ? { pending: true as const }
        : {})
    }
    if (state === 'running' && retain) {
      this.tools.set(update.toolCallId, snapshot)
    } else {
      this.tools.delete(update.toolCallId)
    }
    const events: ProviderTimelineEvent[] = [
      {
        type: state === 'running' ? (previous ? 'item.update' : 'item.open') : 'item.close',
        item: `tool:${update.toolCallId}`,
        body,
        join
      }
    ]
    for (const content of update.content ?? []) {
      if (content.type === 'diff') {
        events.push({
          type: 'item.update',
          item: `diff:${JSON.stringify([update.toolCallId, content.path])}`,
          body: {
            kind: 'diff',
            path: content.path,
            patch: journalPayload(
              boundedPatch(content.path, content.oldText ?? '', content.newText)
            )
          },
          join
        })
      } else if (
        content.type === 'terminal' ||
        (content.content.type !== 'text' && content.content.type !== 'image')
      ) {
        events.push({
          type: 'provider.frame',
          frameKind: `tool-content:${content.type}`,
          payload: content,
          join
        })
      }
    }
    return events
  }

  running(turn: string): boolean {
    for (const snapshot of this.tools.values()) {
      if (snapshot.turn === turn) {
        return true
      }
    }
    return false
  }

  turn(toolCallId: string): string | undefined {
    return this.tools.get(toolCallId)?.turn ?? this.owners.get(`tool:${toolCallId}`)?.turn
  }

  end(turn: string): void {
    for (const key of this.owners.keys(turn)) {
      if (key.startsWith('tool:')) {
        this.tools.delete(key.slice(5))
        this.whole.delete(key.slice(5))
        this.endedCalls.set(key.slice(5), true)
      }
    }
  }

  dispose(): void {
    this.tools.clear()
    this.whole.clear()
    this.backgrounded.clear()
    this.endedCalls.clear()
  }
}
