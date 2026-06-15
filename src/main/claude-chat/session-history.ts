import { join } from 'node:path'
import { readdir, readFile, stat } from 'node:fs/promises'
import { homedir } from 'node:os'

export type SessionSummary = {
  id: string
  date: string
  summary: string
}

export function encodeProjectDir(cwd: string): string {
  // Why: Claude Code encodes the cwd by replacing '/' and '.' with '-'.
  return cwd.replace(/[/.]/g, '-')
}

export function projectDirFor(home: string, cwd: string): string {
  return join(home, '.claude', 'projects', encodeProjectDir(cwd))
}

type ContentBlock = { type: string; text?: string; tool_use_id?: string }

function extractUserText(content: string | ContentBlock[]): string | null {
  if (typeof content === 'string') {
    return content
  }
  for (const block of content) {
    if (block.type === 'text' && typeof block.text === 'string') {
      return block.text
    }
  }
  return null
}

export async function listSessions(cwd: string, home?: string): Promise<SessionSummary[]> {
  const resolvedHome = home ?? homedir()
  const dir = projectDirFor(resolvedHome, cwd)

  let files: string[]
  try {
    files = await readdir(dir)
  } catch {
    return []
  }

  const jsonlFiles = files.filter((f) => f.endsWith('.jsonl'))

  const summaries: SessionSummary[] = []

  for (const file of jsonlFiles) {
    const id = file.slice(0, -6) // strip .jsonl
    const filePath = join(dir, file)

    let date: string
    let summary: string | null = null

    try {
      const raw = await readFile(filePath, 'utf8')
      const lines = raw.split('\n')

      let firstTimestamp: string | null = null

      for (const line of lines) {
        if (!line.trim()) {
          continue
        }
        let parsed: Record<string, unknown>
        try {
          parsed = JSON.parse(line) as Record<string, unknown>
        } catch {
          continue
        }
        if (parsed['type'] !== 'user') {
          continue
        }
        const msg = parsed['message'] as { role: string; content: unknown } | undefined
        if (!msg || msg.role !== 'user') {
          continue
        }
        const content = msg.content as string | ContentBlock[]
        const text = extractUserText(content)
        if (text === null) {
          continue
        }
        if (firstTimestamp === null) {
          firstTimestamp = typeof parsed['timestamp'] === 'string' ? parsed['timestamp'] : null
        }
        if (summary === null) {
          summary = text.replace(/\n/g, ' ').slice(0, 80)
        }
        break
      }

      if (summary === null) {
        continue
      }

      if (firstTimestamp !== null) {
        date = firstTimestamp
      } else {
        const fileStat = await stat(filePath)
        date = fileStat.mtime.toISOString()
      }
    } catch {
      continue
    }

    summaries.push({ id, date, summary })
  }

  // Sort newest first
  summaries.sort((a, b) => (a.date > b.date ? -1 : a.date < b.date ? 1 : 0))

  return summaries
}

type MessageLine = {
  type: 'user' | 'assistant'
  message: Record<string, unknown>
}

export async function loadSessionTranscript(
  cwd: string,
  sessionId: string,
  home?: string
): Promise<unknown[]> {
  const resolvedHome = home ?? homedir()
  const dir = projectDirFor(resolvedHome, cwd)
  const filePath = join(dir, `${sessionId}.jsonl`)

  const raw = await readFile(filePath, 'utf8')
  const lines = raw.split('\n')

  const events: unknown[] = []

  for (const line of lines) {
    if (!line.trim()) {
      continue
    }
    let parsed: Record<string, unknown>
    try {
      parsed = JSON.parse(line) as Record<string, unknown>
    } catch {
      continue
    }
    const t = parsed['type']
    if (t !== 'user' && t !== 'assistant') {
      continue
    }
    const msg = parsed['message'] as Record<string, unknown> | undefined
    if (!msg) {
      continue
    }
    const event: MessageLine = {
      type: t as 'user' | 'assistant',
      message: msg
    }
    events.push(event)
  }

  return events
}
