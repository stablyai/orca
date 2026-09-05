import type { AgentJournalItemBody } from '../../shared/agent-session-journal-types'
import type { NativeChatBlock } from '../../shared/native-chat-types'
import {
  boundInlineText,
  boundToolInput,
  DEFAULT_JOURNAL_PAYLOAD_LIMITS
} from '../native-chat/agent-session-journal/journal-payload-bounds'
import { unhandledProviderFrameJournalItem } from '../native-chat/agent-session-wire/unhandled-provider-frame'
import { commandActionFacts } from './codex-command-action-class'
import {
  readFirstString,
  readRecord,
  readString,
  readTextContent
} from './codex-item-field-readers'
import type { CodexThreadItem } from './codex-thread-item-identity'
export {
  codexItemIdentity,
  isCodexMessageItemType,
  readCodexThreadItem,
  type CodexThreadItem
} from './codex-thread-item-identity'
export {
  CodexTurnOrdinals,
  MAX_CODEX_TURN_ORDINAL_BYTES,
  MAX_CODEX_TURN_ORDINAL_ENTRIES
} from './codex-turn-ordinals'

// Codex thread items → journal item bodies.

/** `userMessage` carries structured content parts; `agentMessage` a flat text. */
export function codexMessageBlocks(item: CodexThreadItem): NativeChatBlock[] {
  const text =
    item.type === 'agentMessage'
      ? (readString(item, 'text') ?? readTextContent(item, 'content'))
      : readString(item, 'text')
  if (text !== null) {
    return [{ type: 'text', text: boundInlineText(text, DEFAULT_JOURNAL_PAYLOAD_LIMITS).text }]
  }
  const content = item.content
  if (!Array.isArray(content)) {
    return []
  }
  const blocks: NativeChatBlock[] = []
  for (const part of content) {
    if (typeof part !== 'object' || part === null) {
      continue
    }
    const partText = readString(part as Record<string, unknown>, 'text')
    if (partText !== null) {
      blocks.push({
        type: 'text',
        text: boundInlineText(partText, DEFAULT_JOURNAL_PAYLOAD_LIMITS).text
      })
      continue
    }
    const record = part as Record<string, unknown>
    if (record.type === 'image' && typeof record.url === 'string') {
      blocks.push({ type: 'image-ref', url: record.url })
    } else if (record.type === 'localImage' && typeof record.path === 'string') {
      blocks.push({ type: 'image-ref', path: record.path })
    }
  }
  return blocks
}

/** Codex reports `inProgress` then a terminal status; a zero exit code is the
 *  only thing that makes a finished command a success. */
function commandState(item: CodexThreadItem): 'running' | 'completed' | 'failed' {
  const status = readString(item, 'status')
  if (status === null || status === 'inProgress') {
    return 'running'
  }
  if (status !== 'completed') {
    return 'failed'
  }
  const exitCode = item.exitCode
  return typeof exitCode === 'number' && exitCode !== 0 ? 'failed' : 'completed'
}

export type CodexJournalItem = {
  body: AgentJournalItemBody | null
  handled: boolean
}

function commandItem(item: CodexThreadItem): CodexJournalItem {
  const output = readFirstString(item, ['aggregatedOutput', 'aggregated_output'])
  const bounded = output === null ? null : boundInlineText(output, DEFAULT_JOURNAL_PAYLOAD_LIMITS)
  const parsed = commandActionFacts(item)
  return {
    body: {
      kind: 'tool-call',
      name: parsed?.name ?? 'shell',
      // Raw command and cwd stay so the expanded view still shows what ran.
      input: boundToolInput(
        { command: item.command ?? null, cwd: item.cwd ?? null, ...parsed?.fields },
        DEFAULT_JOURNAL_PAYLOAD_LIMITS
      ),
      state: commandState(item),
      ...(bounded === null ? {} : { output: bounded.bounded })
    },
    handled: true
  }
}

function fileChangeItem(item: CodexThreadItem): CodexJournalItem {
  const changes = Array.isArray(item.changes)
    ? item.changes.flatMap((change) => {
        const record = typeof change === 'object' && change !== null ? readRecord(change) : {}
        const path = readString(record, 'path')
        const diff = readString(record, 'diff')
        return path && diff ? [{ path, diff }] : []
      })
    : []
  if (changes.length === 0) {
    return {
      body: {
        kind: 'tool-call',
        name: 'apply_patch',
        input: boundToolInput({ changes: item.changes ?? null }, DEFAULT_JOURNAL_PAYLOAD_LIMITS),
        state: commandState(item)
      },
      handled: true
    }
  }
  const patch = changes.map((change) => change.diff).join('\n')
  const bounded = boundInlineText(patch, DEFAULT_JOURNAL_PAYLOAD_LIMITS).bounded
  return {
    body: {
      kind: 'diff',
      path: changes.length === 1 ? changes[0]!.path : `${changes.length} files`,
      patch: bounded
    },
    handled: true
  }
}

/** The tool name reaches the row verbatim — downstream dispatch (diff renderer,
 *  question parsers, input previews) matches raw identifiers, so any casing
 *  transform would silently miss them. `server/` qualifies it so two servers
 *  exposing the same tool stay distinguishable and neither shadows a built-in. */
function mcpToolCallName(item: CodexThreadItem): string {
  const tool = readString(item, 'tool')
  const server = readString(item, 'server')
  return tool === null ? 'mcp' : server === null ? tool : `${server}/${tool}`
}

/** Row-label derivation only reads top-level keys, so the call's own arguments
 *  have to be the input itself. `arguments` is arbitrary JSON upstream: a
 *  non-object stays addressable under a key rather than being dropped, while a
 *  no-argument call — `{}` on the wire, the shape every argument-less MCP tool
 *  sends — becomes null so the row reads as a bare `server/tool` instead of a
 *  literal `{}`. */
function mcpToolArguments(value: unknown): unknown {
  if (typeof value !== 'object' || value === null) {
    return value === null || value === undefined ? null : { arguments: value }
  }
  return Array.isArray(value) ? { arguments: value } : Object.keys(value).length > 0 ? value : null
}

function mcpToolCallItem(item: CodexThreadItem): CodexJournalItem {
  const failure = readString(readRecord(item.error), 'message')
  const text = failure ?? readTextContent(readRecord(item.result), 'content')
  const bounded = text === null ? null : boundInlineText(text, DEFAULT_JOURNAL_PAYLOAD_LIMITS)
  return {
    body: {
      kind: 'tool-call',
      name: mcpToolCallName(item),
      input: boundToolInput(mcpToolArguments(item.arguments), DEFAULT_JOURNAL_PAYLOAD_LIMITS),
      state: failure === null ? commandState(item) : 'failed',
      ...(bounded === null ? {} : { output: bounded.bounded })
    },
    handled: true
  }
}

/** A row label is read off top-level keys only, so the action's own labelable
 *  fields are hoisted beside the query while `action` stays whole for the
 *  expanded detail. The action `type` lands on `description`, the lowest-ranked
 *  label key, so it names only an action that carries nothing better. */
function webSearchInput(item: CodexThreadItem): Record<string, unknown> | null {
  const action = readRecord(item.action)
  const fields: [string, unknown][] = [
    ['url', readString(action, 'url')],
    ['pattern', readString(action, 'pattern')],
    ['description', readString(action, 'type')],
    ['action', item.action ?? null]
  ]
  const query = readString(item, 'query') ?? readString(action, 'query')
  const present = fields.filter(([, value]) => value !== null)
  // A blank `query` is the run header's "this call has no brief argument"
  // signal; drop the key and the header stands the row's raw JSON in for one.
  return query === null && present.length === 0
    ? null
    : { query: query ?? '', ...Object.fromEntries(present) }
}

/** `webSearch` carries no status: Codex starts it with an empty query and a null
 *  action, then sends the action, so `action` is the completion signal — a
 *  completed item's own `query` is routinely still empty. The hits arrive on
 *  `results` and are the call's output. */
function webSearchItem(item: CodexThreadItem): CodexJournalItem {
  const hits = Array.isArray(item.results) && item.results.length > 0 ? item.results : null
  const bounded = hits && boundInlineText(JSON.stringify(hits), DEFAULT_JOURNAL_PAYLOAD_LIMITS)
  return {
    body: {
      kind: 'tool-call',
      name: 'web_search',
      input: boundToolInput(webSearchInput(item), DEFAULT_JOURNAL_PAYLOAD_LIMITS),
      state: item.action === null || item.action === undefined ? 'running' : 'completed',
      ...(bounded === null ? {} : { output: bounded.bounded })
    },
    handled: true
  }
}

/**
 * Journal body for a Codex item, or null for one with nothing to render.
 *
 * Known empty items wait for later deltas. Unknown types become bounded status
 * rows so a provider release cannot make new activity invisible.
 */
export function codexJournalItem(item: CodexThreadItem): CodexJournalItem {
  if (item.type === 'userMessage' || item.type === 'agentMessage') {
    const blocks = codexMessageBlocks(item)
    return {
      body:
        blocks.length === 0
          ? null
          : { kind: 'message', role: item.type === 'userMessage' ? 'user' : 'assistant', blocks },
      handled: true
    }
  }
  if (item.type === 'commandExecution') {
    return commandItem(item)
  }
  if (item.type === 'fileChange') {
    return fileChangeItem(item)
  }
  if (item.type === 'mcpToolCall') {
    return mcpToolCallItem(item)
  }
  if (item.type === 'webSearch') {
    return webSearchItem(item)
  }
  if (item.type === 'reasoning' || item.type === 'plan') {
    const text =
      readTextContent(item, 'text') ??
      readTextContent(item, 'summary') ??
      readTextContent(item, 'content')
    return {
      body:
        text === null
          ? null
          : { kind: 'status', text: boundInlineText(text, DEFAULT_JOURNAL_PAYLOAD_LIMITS).text },
      handled: true
    }
  }
  const unhandled = unhandledProviderFrameJournalItem('codex', `item:${item.type}`, item)
  return unhandled ? { body: unhandled.body, handled: false } : { body: null, handled: true }
}

export function codexItemBody(item: CodexThreadItem): AgentJournalItemBody | null {
  return codexJournalItem(item).body
}

/** Snapshot body for text still streaming, before its item completes. */
export function codexStreamingMessageBody(text: string): AgentJournalItemBody {
  return {
    kind: 'message',
    role: 'assistant',
    blocks: [{ type: 'text', text: boundInlineText(text, DEFAULT_JOURNAL_PAYLOAD_LIMITS).text }]
  }
}

/** Snapshot body for any item-level stream, keyed onto its parent item. */
export function codexStreamingJournalItem(item: CodexThreadItem, text: string): CodexJournalItem {
  if (item.type === 'agentMessage') {
    return { body: codexStreamingMessageBody(text), handled: true }
  }
  if (item.type === 'commandExecution') {
    return commandItem({ ...item, aggregatedOutput: text })
  }
  if (item.type === 'fileChange') {
    const path = Array.isArray(item.changes)
      ? readString(readRecord(item.changes[0]), 'path')
      : null
    const bounded = boundInlineText(text, DEFAULT_JOURNAL_PAYLOAD_LIMITS).bounded
    return {
      body: { kind: 'diff', path: path ?? 'pending patch', patch: bounded },
      handled: true
    }
  }
  const bounded = boundInlineText(text, DEFAULT_JOURNAL_PAYLOAD_LIMITS)
  return { body: { kind: 'status', text: bounded.text }, handled: true }
}
