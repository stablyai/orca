// What a hello's snapshot tells the cloud: recently active cloud conversations, within the contract's caps.
import {
  cloudConversation,
  CONNECTOR_CLIENT_LIMITS,
  CONNECTOR_CLOUD_PROMPTS_AUDIENCE_FEATURE,
  type ConnectorEvent,
  type ConnectorPrompt
} from '../../shared/connectors/connector-cloud-contract'
import type { ConversationSnapshot } from '../external-conversations/external-conversation-events'

type Snapshot = Extract<ConnectorEvent, { kind: 'snapshot' }>

export const jsonBytes = (value: unknown): number => Buffer.byteLength(JSON.stringify(value))

/** A prompt too large to carry, offered as one only Orca can answer. Who raised it stays: without it
 *  the cloud would read it as its conversation's. */
export const unsupported = ({
  promptId,
  raisedBy,
  wokenBy,
  open
}: ConnectorPrompt): ConnectorPrompt => ({
  kind: 'unsupported',
  promptId,
  ...(raisedBy ? { raisedBy } : {}),
  ...(wokenBy ? { wokenBy } : {}),
  ...(open ? { open } : {})
})

/**
 * Linked conversations active within the window, newest first, at most maxSnapshotConversations. Working,
 * prompting or running workers counts as active now. Past the event cap, prompts go unsupported, then the least recent go.
 * `trimmed` says whether a recently active conversation was left out; `omitted` names each one and
 * why, and `downgraded` the panes whose prompt went as unsupported, for the snapshot's trace.
 */
export function connectorSnapshot(
  event: ConversationSnapshot,
  now: number,
  cloudFeatures: ReadonlySet<string> = new Set()
): {
  snapshot: Snapshot
  trimmed: boolean
  inWindow: number
  omitted: { paneKey: string; reason: 'count' | 'bytes' }[]
  downgraded: Set<string>
} {
  const since = now - CONNECTOR_CLIENT_LIMITS.snapshotActiveWindowMs
  const recent = event.conversations
    .flatMap((entry) => {
      const conversation = cloudConversation(entry.conversation)
      const activeAt = entry.working || entry.prompt || entry.workersRunning ? now : entry.activeAt
      return conversation && activeAt >= since ? [{ ...entry, conversation, activeAt }] : []
    })
    .sort((a, b) => b.activeAt - a.activeAt)
  let conversations: Snapshot['conversations'] = recent
    .slice(0, CONNECTOR_CLIENT_LIMITS.maxSnapshotConversations)
    .map(({ conversation, paneKey, agent, working, prompt, turnId, workersRunning }) => ({
      conversation,
      paneKey,
      agent,
      working,
      prompt:
        prompt?.raisedBy === 'orca' && !cloudFeatures.has(CONNECTOR_CLOUD_PROMPTS_AUDIENCE_FEATURE)
          ? null
          : prompt,
      ...(turnId === null ? {} : { turnId }),
      ...(workersRunning === undefined ? {} : { workersRunning })
    }))
  const fits = (): boolean =>
    jsonBytes({ kind: 'snapshot', conversations }) <= CONNECTOR_CLIENT_LIMITS.maxEventBytes
  const downgraded = new Set<string>()
  if (!fits()) {
    conversations = conversations.map((entry) => {
      if (entry.prompt && entry.prompt.kind !== 'unsupported') {
        downgraded.add(entry.paneKey)
      }
      return entry.prompt ? { ...entry, prompt: unsupported(entry.prompt) } : entry
    })
  }
  const counted = conversations.length
  while (conversations.length > 0 && !fits()) {
    conversations = conversations.slice(0, -1)
  }
  const omitted = recent.slice(conversations.length).map((entry, index) => ({
    paneKey: entry.paneKey,
    reason: conversations.length + index < counted ? ('bytes' as const) : ('count' as const)
  }))
  for (const { paneKey } of omitted) {
    downgraded.delete(paneKey)
  }
  return {
    snapshot: { kind: 'snapshot', conversations },
    trimmed: conversations.length < recent.length,
    inWindow: recent.length,
    omitted,
    downgraded
  }
}

/** Cut on a character boundary so the cloud's byte limit always holds. */
export function capUtf8(text: string, maxBytes: number): string {
  const bytes = Buffer.from(text)
  if (bytes.byteLength <= maxBytes) {
    return text
  }
  let end = maxBytes
  // Step back over continuation bytes (10xxxxxx) to the start of the cut character.
  while (end > 0 && ((bytes[end] ?? 0) & 0xc0) === 0x80) {
    end--
  }
  return bytes.subarray(0, end).toString('utf8')
}

export const ANSWER_CUT_NOTE = '_… cut short here. The full answer is in Orca._'

// The longest fence a cut answer is given room to close; a longer opener is rare enough to share it.
const CLOSING_FENCE_ROOM = '\n```'

/** The fence that closes the code block the text ends inside, or '' when it ends outside one. A
 *  block closes only on a fence of its own character, at least as long, with nothing after it. */
function openFence(text: string): string {
  let open: string | null = null
  for (const line of text.split('\n')) {
    const fence = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line)
    if (!fence) {
      continue
    }
    const [, marks, rest] = fence
    if (open === null) {
      // Backticks after a backtick fence make the line inline code, which opens nothing.
      open = marks![0] === '`' && rest!.includes('`') ? null : marks!
    } else if (marks![0] === open[0] && marks!.length >= open.length && rest!.trim() === '') {
      open = null
    }
  }
  return open ?? ''
}

/**
 * An answer within the cloud's byte limit that says so when it was cut: ended at a line break where
 * one is near, an open code block closed, then the note. A reader otherwise takes the cut for the end.
 */
export function capAnswer(text: string, maxBytes: number): string {
  if (Buffer.byteLength(text) <= maxBytes) {
    return text
  }
  const tail = `\n\n${ANSWER_CUT_NOTE}`
  const room = maxBytes - Buffer.byteLength(tail) - Buffer.byteLength(CLOSING_FENCE_ROOM)
  const cut = capUtf8(text, room)
  const lineEnd = cut.lastIndexOf('\n')
  // A break in the last tenth loses little; any earlier, the words up to the limit are worth more.
  let kept = (lineEnd > cut.length * 0.9 ? cut.slice(0, lineEnd) : cut).trimEnd()
  let fence = openFence(kept)
  // A fence longer than its room takes it from the words.
  if (fence.length + 1 > CLOSING_FENCE_ROOM.length) {
    kept = capUtf8(kept, room - (fence.length + 1 - CLOSING_FENCE_ROOM.length)).trimEnd()
    fence = openFence(kept)
  }
  return `${kept}${fence ? `\n${fence}` : ''}${tail}`
}
