import type { createAgentSessionDeltaCoalescer } from '../../../native-chat/agent-session-wire/publication/subscribers/agent-session-delta-coalescer'
import type { CodexItemStreamDeps } from './codex-structured-item-stream-contracts'

type Coalescer = Pick<
  ReturnType<typeof createAgentSessionDeltaCoalescer>,
  'snapshot' | 'append' | 'someLength'
>

/** Text past its last checkpoint is saved before a hand-off's last ack and on the daemon's ask. */
export function bindCodexCheckpointLiveText(
  sink: CodexItemStreamDeps['sink'],
  coalescer: Coalescer,
  checkpointLengths: ReadonlyMap<string, number>,
  flush: () => unknown
): (() => void) | undefined {
  return sink.bindLiveText?.({
    read: () => [],
    has: () => coalescer.someLength((key, length) => length !== (checkpointLengths.get(key) ?? 0)),
    flush: () => void flush(),
    deferrable: true
  })
}

/**
 * A kept command's stream resumes from the text its row already holds (not a change to save); a
 * truncated row (`text` null) is held whole until the command's own end.
 */
export function seedCodexKeptStreamText(
  key: string,
  text: string | null,
  known: boolean,
  coalescer: Coalescer,
  checkpointLengths: Map<string, number>,
  heldUntilEnd: Set<string>
): void {
  if (text === null) {
    heldUntilEnd.add(key)
  } else if (known && !coalescer.snapshot(key) && coalescer.append(key, text)) {
    checkpointLengths.set(key, text.length)
  }
}
