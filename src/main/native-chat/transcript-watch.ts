// Live transcript tailing: watch a resolved session JSONL file and emit only
// the messages parsed from bytes appended since the last read. Modeled on the
// incremental byte-offset read in codex-usage/scanner.ts (parseCodexUsageFile's
// skipInitialBytes), but specialized to the NativeChatMessage record decoders.
//
// Teardown discipline (plan U4 risk: file-watch fd leaks): every subscription
// owns exactly one fs.FSWatcher and one debounce timer. unsubscribe() closes
// the watcher and clears the timer synchronously, and the module tracks the live
// watcher count so tests can assert no watcher survives teardown.

import { watch, type FSWatcher } from 'node:fs'
import { open, stat } from 'node:fs/promises'
import type { Readable } from 'node:stream'
import type { AgentType, NativeChatMessage } from '../../shared/native-chat-types'
import { resolveSessionFilePath, type ResolveSessionFileOptions } from './session-file-resolver'
import { decodeClaudeTranscriptLine, decodeCodexTranscriptLine } from './transcript-line-decoders'

export type SubscribeNativeChatTranscriptArgs = ResolveSessionFileOptions & {
  agent: AgentType
  sessionId: string
  /** Called with the newly-appended messages whenever the file grows. Never
   *  called with an empty array. */
  onAppend: (messages: NativeChatMessage[]) => void
  /** Resolve directly to this file, skipping path discovery (used by tests). */
  filePath?: string
  /** Coalesce window for rapid fs.watch events (ms). Defaults to 40ms. */
  debounceMs?: number
}

export type NativeChatTranscriptSubscription = {
  /** Closes the watcher and releases the file handle. Idempotent. */
  unsubscribe: () => void
}

// Why: a single watch event can fire several times for one append; we read from
// the last byte offset so re-entrant reads never re-emit prior messages. Each
// decoder is stateless per-line, so tailing reuses the same record→message
// mapping the full reader uses.
const DEFAULT_DEBOUNCE_MS = 40

// Why: process-wide count of live FSWatchers opened by this module. The U4 leak
// test asserts this returns to zero after unsubscribe so a forgotten handle is
// caught deterministically rather than relying on OS fd inspection.
let activeWatcherCount = 0

/** Test-only: number of fs watchers this module currently holds open. */
export function getActiveNativeChatWatcherCount(): number {
  return activeWatcherCount
}

function lineDecoderForAgent(
  agent: AgentType
): ((line: string, fallbackId: string) => NativeChatMessage | null) | null {
  if (agent === 'claude') {
    return decodeClaudeTranscriptLine
  }
  if (agent === 'codex') {
    return decodeCodexTranscriptLine
  }
  return null
}

async function fileSize(filePath: string): Promise<number> {
  try {
    return (await stat(filePath)).size
  } catch {
    return 0
  }
}

/**
 * Read bytes [start, end) of the file and decode each complete line into a
 * NativeChatMessage. Opens its own fd and always closes it (no leak on the read
 * path, distinct from the long-lived watcher). Returns the messages plus the
 * byte offset actually consumed so a partially-written trailing line is re-read
 * on the next append rather than dropped.
 */
async function readAppendedMessages(
  filePath: string,
  start: number,
  decode: (line: string, fallbackId: string) => NativeChatMessage | null
): Promise<{ messages: NativeChatMessage[]; consumedTo: number }> {
  const end = await fileSize(filePath)
  if (end <= start) {
    // File shrank (rotation/replacement) or unchanged — caller resets offset.
    return { messages: [], consumedTo: end }
  }

  const handle = await open(filePath, 'r')
  try {
    const stream = handle.createReadStream({
      encoding: 'utf-8',
      start,
      end: end - 1,
      autoClose: false
    })
    const { messages, consumedBytes } = await decodeStreamLines(stream, filePath, start, decode)
    return { messages, consumedTo: start + consumedBytes }
  } finally {
    await handle.close()
  }
}

async function decodeStreamLines(
  stream: Readable,
  filePath: string,
  start: number,
  decode: (line: string, fallbackId: string) => NativeChatMessage | null
): Promise<{ messages: NativeChatMessage[]; consumedBytes: number }> {
  const text = await readStreamText(stream)
  const completeEnd = text.lastIndexOf('\n')
  if (completeEnd === -1) {
    return { messages: [], consumedBytes: 0 }
  }

  // Why: transcript writers can flush mid-record. Only advance through
  // newline-terminated JSONL so invalid partial JSON is retried on the next
  // append instead of being lost forever.
  const completeText = text.slice(0, completeEnd + 1)
  const lines = completeText.split('\n')
  const messages: NativeChatMessage[] = []
  for (const [index, line] of lines.entries()) {
    if (!line) {
      continue
    }
    // Fallback id embeds the byte offset so ids stay stable+unique across
    // appends even when a record carries no intrinsic id.
    const message = decode(line, `${filePath}:${start}:${index}`)
    if (message) {
      messages.push(message)
    }
  }
  return { messages, consumedBytes: Buffer.byteLength(completeText, 'utf8') }
}

async function readStreamText(stream: Readable): Promise<string> {
  const chunks: string[] = []
  for await (const chunk of stream) {
    chunks.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'))
  }
  return chunks.join('')
}

/**
 * Subscribe to live appends on an agent's transcript file. Returns an
 * unsubscribe fn that tears the watcher down completely.
 *
 * Handles file rotation/replacement: when the file shrinks (a new session id
 * resolved to a smaller/newer file, or the file was truncated), the offset is
 * reset to 0 so the replacement's content is read from the top.
 */
export async function subscribeNativeChatTranscript(
  args: SubscribeNativeChatTranscriptArgs
): Promise<NativeChatTranscriptSubscription> {
  const { agent, sessionId, onAppend, debounceMs } = args
  const decode = lineDecoderForAgent(agent)
  const filePath = args.filePath ?? (await resolveSessionFilePath(agent, sessionId, args))

  if (!filePath || !decode) {
    // Nothing watchable — return a no-op teardown so callers can unconditionally
    // unsubscribe without null-checks.
    return { unsubscribe: () => {} }
  }

  // Why: seed the offset at 0 so the FIRST drain re-reads the whole file. This
  // closes the read/subscribe race — a turn appended between the caller's
  // readSession EOF and the watcher install is still emitted. Re-emitted lines
  // collapse by deterministic id in the assembler (no dup, no drop). Subsequent
  // drains use the incremental offset so the full re-read happens only once.
  let offset = 0
  let closed = false
  let reading = false
  let pendingReadRequested = false
  let debounceTimer: ReturnType<typeof setTimeout> | null = null

  async function drain(): Promise<void> {
    if (closed) {
      return
    }
    if (reading) {
      // A read is already in flight; mark that another pass is needed so rapid
      // successive appends coalesce without dropping the trailing one.
      pendingReadRequested = true
      return
    }
    reading = true
    try {
      do {
        pendingReadRequested = false
        try {
          const currentSize = await fileSize(filePath!)
          if (currentSize < offset) {
            // Rotation/replacement/truncation: re-read from the top.
            offset = 0
          }
          const { messages, consumedTo } = await readAppendedMessages(filePath!, offset, decode!)
          offset = consumedTo
          if (!closed && messages.length > 0) {
            onAppend(messages)
          }
        } catch {
          // Why: a transient read failure (EACCES/EIO/ENOENT during rotation)
          // must not leave the subscription permanently deaf. Stop this drain;
          // the finally resets `reading` so a later fs event re-arms the read.
          break
        }
      } while (pendingReadRequested && !closed)
    } finally {
      reading = false
    }
  }

  function scheduleDrain(): void {
    if (closed) {
      return
    }
    if (debounceTimer) {
      clearTimeout(debounceTimer)
    }
    debounceTimer = setTimeout(() => {
      debounceTimer = null
      void drain()
    }, debounceMs ?? DEFAULT_DEBOUNCE_MS)
  }

  let watcher: FSWatcher
  try {
    watcher = watch(filePath, scheduleDrain)
  } catch {
    // File vanished between resolve and watch — return a no-op teardown.
    return { unsubscribe: () => {} }
  }
  activeWatcherCount++

  // Why: on some platforms fs.watch can miss the very first append that lands
  // between offset-seed and watcher install. Kick one debounced drain so a
  // turn written immediately after subscribe is still picked up.
  scheduleDrain()

  return {
    unsubscribe: () => {
      if (closed) {
        return
      }
      closed = true
      if (debounceTimer) {
        clearTimeout(debounceTimer)
        debounceTimer = null
      }
      watcher.close()
      activeWatcherCount--
    }
  }
}
