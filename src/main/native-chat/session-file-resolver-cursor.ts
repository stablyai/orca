import { homedir } from 'node:os'
import { basename, extname, join } from 'node:path'
import { sessionIdFromFileName } from '../ai-vault/session-scanner-accumulator'
import { walkSessionFiles } from '../ai-vault/session-scanner-discovery'

function cursorProjectsDir(): string {
  return join(homedir(), '.cursor', 'projects')
}

/** Cursor stores JSONL under `~/.cursor/projects/<slug>/agent-transcripts/`. */
export async function resolveCursorSessionFile(
  sessionId: string,
  projectsDir = cursorProjectsDir(),
  signal?: AbortSignal
): Promise<string | null> {
  const files = await walkSessionFiles(projectsDir, 'cursor', [], {
    extensions: new Set(['.jsonl']),
    filePredicate: (filePath) => isCursorTranscriptForSession(filePath, sessionId),
    signal
  })
  return files[0] ?? null
}

function isCursorTranscriptForSession(filePath: string, sessionId: string): boolean {
  if (!filePath.split(/[/\\]/).includes('agent-transcripts')) {
    return false
  }
  const name = basename(filePath, extname(filePath))
  return name === sessionId || sessionIdFromFileName(filePath) === sessionId
}
