import { appendFileSync, mkdirSync, readFileSync, statSync, renameSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { VoiceTranscriptEntry } from '../../shared/voice-control-types'

/**
 * The voice session's durable transcript: what the user said, what the coordinator said
 * back, commands it ran (with results), and work updates it relayed. One JSONL file under
 * userData, rotated by size — the transcript panel backfills from it, and "what on earth
 * happened in that session" is answerable without the trace spans. The renderer shows the
 * same entries live; this file is the after-restart memory.
 */

export type { VoiceTranscriptEntry }

const LOG_FILE_NAME = 'transcript.jsonl'
/** ~1 MB of transcript is weeks of voice sessions; rotate, don't grow. */
const MAX_LOG_BYTES = 1024 * 1024
/** Readback for the panel: the newest entries, bounded. */
const READBACK_LIMIT = 200

export class VoiceControlTranscriptLog {
  // mkdir once per log; the size is one statSync at first append (covering a previous
  // run's file), then tracked in memory — this class is the file's only writer per run.
  private dirReady = false
  private logBytes: number | null = null

  constructor(private readonly filePath: string) {}

  append(entry: VoiceTranscriptEntry): void {
    try {
      if (!this.dirReady) {
        mkdirSync(dirname(this.filePath), { recursive: true })
        this.dirReady = true
      }
      const line = `${JSON.stringify(entry)}\n`
      this.logBytes ??= statSync(this.filePath, { throwIfNoEntry: false })?.size ?? 0
      if (this.logBytes > MAX_LOG_BYTES) {
        // One generation of history is enough for a convenience log.
        renameSync(this.filePath, `${this.filePath}.1`)
        this.logBytes = 0
      }
      appendFileSync(this.filePath, line, 'utf8')
      this.logBytes += Buffer.byteLength(line, 'utf8')
    } catch {
      // A convenience log must never break the session it records.
    }
  }

  read(): VoiceTranscriptEntry[] {
    return readVoiceTranscriptLog(this.filePath)
  }
}

export function readVoiceTranscriptLog(filePath: string): VoiceTranscriptEntry[] {
  let raw: string
  try {
    raw = readFileSync(filePath, 'utf8')
  } catch {
    return []
  }
  const entries: VoiceTranscriptEntry[] = []
  for (const line of raw.split('\n')) {
    if (!line.trim()) {
      continue
    }
    try {
      const parsed: unknown = JSON.parse(line)
      if (isVoiceTranscriptEntry(parsed)) {
        entries.push(parsed)
      }
    } catch {
      // A torn tail line (crash mid-append) is skipped, never fatal.
    }
  }
  return entries.slice(-READBACK_LIMIT)
}

function isVoiceTranscriptEntry(value: unknown): value is VoiceTranscriptEntry {
  if (typeof value !== 'object' || value === null) {
    return false
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: object/non-null check above is the full contract for a JSON-parsed line.
  const record = value as Record<string, unknown>
  return (
    typeof record.ts === 'number' &&
    (record.kind === 'user' ||
      record.kind === 'assistant' ||
      record.kind === 'command' ||
      record.kind === 'update' ||
      record.kind === 'ui') &&
    typeof (record.text ?? record.command ?? record.summary) === 'string'
  )
}

export function voiceControlTranscriptLogPath(userDataDir: string): string {
  return join(userDataDir, 'voice-control', LOG_FILE_NAME)
}
