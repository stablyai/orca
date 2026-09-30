import { readFile, writeFile } from 'node:fs/promises'
import type { PersistedAgentSessionLease } from '../../shared/agent-session-legacy-handoff-lease'
import { agentSessionStorePath } from './agent-session-record-store-file'

type StoreFile = { records: Record<string, { lease: Record<string, unknown> }> }

/** Rewrites one lease on disk as an older build left it; this build's types cannot express it. */
export async function writeOlderBuildLease(
  directory: string,
  sessionId: string,
  fields: Partial<PersistedAgentSessionLease>
): Promise<void> {
  const path = agentSessionStorePath(directory)
  const file: StoreFile = JSON.parse(await readFile(path, 'utf-8'))
  file.records[sessionId].lease = { ...file.records[sessionId].lease, ...fields }
  await writeFile(path, JSON.stringify(file))
}

export async function readPersistedLease(
  directory: string,
  sessionId: string
): Promise<Record<string, unknown>> {
  const file: StoreFile = JSON.parse(await readFile(agentSessionStorePath(directory), 'utf-8'))
  return file.records[sessionId].lease
}
