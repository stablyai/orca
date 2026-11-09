import { open, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { encodeClaudeProjectPaths } from '../ai-vault/scanners/claude/claude-project-dir-encoding'

const FIRST_WINDOW_BYTES = 64 * 1024

/**
 * Claude can name a transcript file differently from the provider session id its rows carry, so a
 * filename lookup miss cannot prove the history is absent. Read the leading window of the files in
 * the project buckets this workspace would have used; every row names its session.
 */
export async function findClaudeTranscriptBySessionIdContent(input: {
  projectsDir: string
  workspaceCwd: string
  providerSessionId: string
}): Promise<string | null> {
  for (const bucket of encodeClaudeProjectPaths(input.workspaceCwd)) {
    const directory = join(input.projectsDir, bucket)
    let names: string[]
    try {
      names = await readdir(directory)
    } catch {
      continue
    }
    for (const name of names) {
      if (!name.endsWith('.jsonl')) {
        continue
      }
      const file = join(directory, name)
      if ((await readLeadingSessionId(file)) === input.providerSessionId) {
        return file
      }
    }
  }
  return null
}

async function readLeadingSessionId(file: string): Promise<string | null> {
  try {
    const handle = await open(file, 'r')
    try {
      const buffer = Buffer.alloc(FIRST_WINDOW_BYTES)
      const { bytesRead } = await handle.read(buffer, 0, FIRST_WINDOW_BYTES, 0)
      const match = /"sessionId"\s*:\s*"([^"]+)"/.exec(buffer.toString('utf8', 0, bytesRead))
      return match?.[1] ?? null
    } finally {
      await handle.close()
    }
  } catch {
    return null
  }
}
