import { open, readdir } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { encodeClaudeProjectPaths } from '../ai-vault/scanners/claude/claude-project-dir-encoding'

const FIRST_WINDOW_BYTES = 64 * 1024

function isMissingPathError(error: unknown): boolean {
  return (
    error instanceof Error &&
    'code' in error &&
    (error.code === 'ENOENT' || error.code === 'ENOTDIR')
  )
}

/**
 * Claude can name a transcript file differently from the provider session id its rows carry, so a
 * filename lookup miss cannot prove the history is absent. Read the leading window of the files in
 * the buckets a CLI started in could have used; every row names its session.
 * A read that fails for any reason other than absence leaves absence unproven (#37707 review).
 */
export async function findClaudeTranscriptBySessionIdContent(input: {
  projectsDir: string
  workspaceCwd: string
  providerSessionId: string
  strictErrors?: boolean
}): Promise<string | null> {
  let sawUnreadable = false
  for (const bucket of startingBuckets(input.workspaceCwd)) {
    const directory = join(input.projectsDir, bucket)
    let names: string[]
    try {
      names = await readdir(directory)
    } catch (error) {
      if (!isMissingPathError(error)) {
        sawUnreadable = true
      }
      continue
    }
    for (const name of names) {
      if (!name.endsWith('.jsonl')) {
        continue
      }
      const file = join(directory, name)
      const leading = await readLeadingSessionId(file)
      if (leading.kind === 'session' && leading.id === input.providerSessionId) {
        return file
      }
      if (leading.kind === 'unreadable') {
        sawUnreadable = true
      }
    }
  }
  if (sawUnreadable && input.strictErrors === true) {
    // Strict adoption must not turn an unreadable candidate into a blank chat.
    throw new Error(
      'A Claude transcript could not be read, so the conversation history cannot be proven absent.'
    )
  }
  return null
}

/** A CLI that started in a parent of the workspace filed under that parent's bucket. */
function startingBuckets(workspaceCwd: string): string[] {
  const buckets = new Set<string>()
  let current = workspaceCwd
  for (;;) {
    for (const bucket of encodeClaudeProjectPaths(current)) {
      buckets.add(bucket)
    }
    const parent = dirname(current)
    if (parent === current) {
      break
    }
    current = parent
  }
  return [...buckets]
}

type LeadingRead = { kind: 'session'; id: string } | { kind: 'none' } | { kind: 'unreadable' }

async function readLeadingSessionId(file: string): Promise<LeadingRead> {
  try {
    const handle = await open(file, 'r')
    try {
      const buffer = Buffer.alloc(FIRST_WINDOW_BYTES)
      const { bytesRead } = await handle.read(buffer, 0, FIRST_WINDOW_BYTES, 0)
      const text = buffer.toString('utf8', 0, bytesRead)
      const lines = text.split('\n')
      // The read window can cut the last row; a truncated row proves nothing.
      const trailingPartial = bytesRead === FIRST_WINDOW_BYTES && !text.endsWith('\n')
      if (trailingPartial) {
        lines.pop()
      }
      for (const line of lines) {
        if (!line.trim()) {
          continue
        }
        let row: unknown
        try {
          row = JSON.parse(line)
        } catch {
          return { kind: 'unreadable' }
        }
        // Rows carry their own top-level session; nested message payloads can name another one.
        const sessionId =
          row && typeof row === 'object' && 'sessionId' in row ? row.sessionId : undefined
        if (typeof sessionId === 'string') {
          return { kind: 'session', id: sessionId }
        }
      }
      // A window cut mid-row cannot establish the session; a readable file with no rows just has
      // no history (#37707 review).
      return trailingPartial ? { kind: 'unreadable' } : { kind: 'none' }
    } finally {
      await handle.close()
    }
  } catch (error) {
    return isMissingPathError(error) ? { kind: 'none' } : { kind: 'unreadable' }
  }
}
