import { dirname, join } from 'node:path'

const ANTIGRAVITY_TRANSCRIPT_FILE = 'transcript.jsonl'
const ANTIGRAVITY_SYSTEM_DIR = '.system_generated'
const ANTIGRAVITY_LOGS_DIR = 'logs'

export function antigravityConversationIdFromTranscriptPath(filePath: string): string | null {
  const segments = pathSegments(filePath)
  const transcriptIndex = segments.length - 1
  if (
    segments[transcriptIndex] !== ANTIGRAVITY_TRANSCRIPT_FILE ||
    segments[transcriptIndex - 1] !== ANTIGRAVITY_LOGS_DIR ||
    segments[transcriptIndex - 2] !== ANTIGRAVITY_SYSTEM_DIR
  ) {
    return null
  }
  return segments[transcriptIndex - 3] ?? null
}

export function isAntigravityTranscriptPath(filePath: string): boolean {
  return antigravityConversationIdFromTranscriptPath(filePath) !== null
}

export function shouldDescendAntigravityBrainDirectory(name: string, depth: number): boolean {
  // Why: brain entries contain large artifact trees; only the fixed transcript
  // chain is part of the resumable conversation contract.
  if (depth === 0) {
    return true
  }
  if (depth === 1) {
    return name === ANTIGRAVITY_SYSTEM_DIR
  }
  return depth === 2 && name === ANTIGRAVITY_LOGS_DIR
}

export function antigravityHistoryPathForBrainDir(brainDir: string): string {
  return join(dirname(brainDir), 'history.jsonl')
}

function pathSegments(filePath: string): string[] {
  return filePath.split(/[\\/]+/).filter(Boolean)
}
