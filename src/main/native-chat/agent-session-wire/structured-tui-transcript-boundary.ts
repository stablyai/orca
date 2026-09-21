import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { durableWriteTempPath, writeFileDurable } from '../../durable-file-write'

const BOUNDARY_FILE = 'structured-tui-transcript-boundary.json'
const BOUNDARY_SCHEMA_VERSION = 1

export type StructuredTuiTranscriptBoundary = {
  providerSessionId: string
  runtimeFence: number
  filePath: string | null
  offset: number
}

function boundaryPath(journalDirectory: string): string {
  return join(journalDirectory, BOUNDARY_FILE)
}

export async function readStructuredTuiTranscriptBoundary(
  journalDirectory: string
): Promise<StructuredTuiTranscriptBoundary | null> {
  let parsed: unknown
  try {
    parsed = JSON.parse(await readFile(boundaryPath(journalDirectory), 'utf8'))
  } catch {
    return null
  }
  if (!parsed || typeof parsed !== 'object') {
    return null
  }
  const value = parsed as Record<string, unknown>
  if (
    value.schemaVersion !== BOUNDARY_SCHEMA_VERSION ||
    typeof value.providerSessionId !== 'string' ||
    !Number.isSafeInteger(value.runtimeFence) ||
    (value.filePath !== null && typeof value.filePath !== 'string') ||
    !Number.isSafeInteger(value.offset) ||
    (value.offset as number) < 0
  ) {
    return null
  }
  return {
    providerSessionId: value.providerSessionId,
    runtimeFence: value.runtimeFence as number,
    filePath: value.filePath as string | null,
    offset: value.offset as number
  }
}

export async function writeStructuredTuiTranscriptBoundary(
  journalDirectory: string,
  boundary: StructuredTuiTranscriptBoundary
): Promise<void> {
  const filePath = boundaryPath(journalDirectory)
  await writeFileDurable(
    durableWriteTempPath(filePath),
    filePath,
    JSON.stringify({ schemaVersion: BOUNDARY_SCHEMA_VERSION, ...boundary })
  )
}
