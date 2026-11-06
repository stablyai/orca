import type { AcpItemOwnership } from './acp-item-ownership'
import type { AcpOwnershipReader } from './acp-ownership-reader'
import { createPatch } from 'diff'
import { z } from 'zod'
import type { AgentJournalToolCallItem } from '../../shared/agent-session/journal/agent-session-journal-types'
import {
  boundToolInput,
  JOURNAL_RUNNING_PREVIEW_LIMITS,
  journalPayload,
  journalToolPayload
} from '../native-chat/agent-session-journal/journal-payload-bounds'
import type {
  ProviderTimelineEvent,
  ProviderTimelineJoin
} from '../native-chat/agent-session-timeline/provider-timeline-event'
import type { AcpDialect } from './acp-dialects/acp-dialect'
import type { ToolCallUpdate } from './generated/acp-protocol.generated'

const rawStreamsSchema = z.object({ stdout: z.string().optional(), stderr: z.string().optional() })
const rawExitCodeSchema = z.looseObject({ exitCode: z.number().int().safe() })

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

// Whole-file replacement avoids expensive diffs for large unrelated files.
function replacementPatch(path: string, oldText: string, newText: string): string {
  const lines = (text: string, prefix: string): { count: number; text: string } => {
    if (!text) {
      return { count: 0, text: '' }
    }
    const entries = text.split('\n')
    if (entries.at(-1) === '') {
      entries.pop()
    }
    return {
      count: entries.length,
      text:
        entries.map((line) => `${prefix}${line}\n`).join('') +
        (text.endsWith('\n') ? '' : '\\ No newline at end of file\n')
    }
  }
  const oldLines = lines(oldText, '-')
  const newLines = lines(newText, '+')
  return `--- ${path}\n+++ ${path}\n@@ -${oldLines.count ? 1 : 0},${oldLines.count} +${newLines.count ? 1 : 0},${newLines.count} @@\n${oldLines.text}${newLines.text}`
}

function boundedDiffPatch(path: string, oldText: string, newText: string): string {
  const patch =
    oldText.length + newText.length <= 256 * 1024
      ? createPatch(path, oldText, newText, undefined, undefined, { maxEditLength: 1024 })
      : undefined
  return patch ?? replacementPatch(path, oldText, newText)
}

type ToolSnapshot = { body: AgentJournalToolCallItem; turn?: string }

// Keep partial-update context until completion or the owning turn ends.
export class AcpToolTimeline {
  private readonly tools = new Map<string, ToolSnapshot>()
  // Closing updates may omit fields; only their running journal copies are previews.
  private readonly whole = new Map<string, { input?: unknown; output?: string }>()

  constructor(
    private readonly owners: AcpItemOwnership,
    private readonly read?: AcpOwnershipReader
  ) {}

  join(toolCallId: string): ProviderTimelineJoin {
    const turn = this.turn(toolCallId)
    if (turn !== undefined) {
      return { turn }
    }
    const scope = this.read?.tool(toolCallId)
    return scope ? { scope } : {}
  }

  translate(
    raw: ToolCallUpdate,
    dialect: AcpDialect,
    join: ProviderTimelineJoin
  ): ProviderTimelineEvent[] {
    join = join.turn === undefined ? { ...join, ...this.join(raw.toolCallId) } : join
    const turn = join.turn
    const retain = turn === undefined ? join.scope === undefined : this.owners.isLive(turn)
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
    if (turn !== undefined) {
      this.owners.remember(`tool:${update.toolCallId}`, turn)
    }
    const snapshot = { body, ...(turn === undefined ? {} : { turn }) }
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
              boundedDiffPatch(content.path, content.oldText ?? '', content.newText)
            )
          },
          join
        })
      } else if (content.type === 'terminal' || content.content.type !== 'text') {
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

  turn(toolCallId: string): string | undefined {
    return this.tools.get(toolCallId)?.turn ?? this.owners.get(`tool:${toolCallId}`)?.turn
  }

  end(turn: string): void {
    for (const key of this.owners.keys(turn)) {
      if (key.startsWith('tool:')) {
        this.tools.delete(key.slice(5))
        this.whole.delete(key.slice(5))
      }
    }
  }

  dispose(): void {
    this.tools.clear()
    this.whole.clear()
  }
}
