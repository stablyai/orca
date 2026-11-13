import { constants, createReadStream } from 'node:fs'
import { access, readdir } from 'node:fs/promises'
import { dirname, isAbsolute, join } from 'node:path'
import { createInterface } from 'node:readline'
import { directoryTranscriptImport } from '../native-chat/conversation-adoption/structured-agent-cli-conversations'
import { kimiPrimaryAgentWirePath } from '../ai-vault/scanners/kimi/session-scanner-kimi-paths'
import { asRecord } from '../ai-vault/parsing/session-record-fields'
import { readJsonObjectIfExists } from '../ai-vault/discovery/session-json-file'

async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path, constants.R_OK)
    return true
  } catch {
    return false
  }
}

function extractString(value: unknown): string | null {
  return typeof value === 'string' ? value : null
}

/** session_index.jsonl rows name the session dir; later rows win over earlier ones. */
async function readSessionDirs(indexPath: string): Promise<Map<string, string>> {
  const map = new Map<string, string>()
  try {
    const lines = createInterface({
      input: createReadStream(indexPath, { encoding: 'utf-8' }),
      crlfDelay: Infinity
    })
    for await (const line of lines) {
      if (!line.trim()) {
        continue
      }
      let record: Record<string, unknown> | null
      try {
        record = asRecord(JSON.parse(line))
      } catch {
        continue
      }
      const sessionId = extractString(record?.sessionId)
      const sessionDir = extractString(record?.sessionDir)
      if (sessionId && sessionDir) {
        map.set(sessionId, sessionDir)
      }
    }
  } catch {
    return map
  }
  return map
}

/** Index misses (an old or deleted index) fall back to the on-disk workspace layout. */
async function scanSessionDirs(sessionsRoot: string, sessionId: string): Promise<string[]> {
  const dirs: string[] = []
  let workspaces
  try {
    workspaces = await readdir(sessionsRoot, { withFileTypes: true })
  } catch {
    return dirs
  }
  for (const workspace of workspaces) {
    if (!workspace.isDirectory()) {
      continue
    }
    const dir = join(sessionsRoot, workspace.name, sessionId)
    if (await fileExists(join(dir, 'state.json'))) {
      dirs.push(dir)
    }
  }
  return dirs
}

/** The main agent's wire.jsonl; state.json names the primary agent when it is not `main`. */
async function wireTranscriptInSessionDir(sessionDir: string): Promise<string | null> {
  const statePath = join(sessionDir, 'state.json')
  const state = await readJsonObjectIfExists(statePath)
  if (!state) {
    return null
  }
  const wire = kimiPrimaryAgentWirePath(statePath, state)
  return (await fileExists(wire)) ? wire : null
}

function resolveSessionDir(sessionDir: string, sessionsRoot: string): string {
  if (isAbsolute(sessionDir)) {
    return sessionDir
  }
  // Relative index entries are written against the data root, one level above sessions/.
  return join(dirname(sessionsRoot), sessionDir)
}

export const KIMI_TRANSCRIPT_IMPORT = directoryTranscriptImport({
  conversationStore: ({ accountHomePath }) => join(accountHomePath, 'sessions'),
  accountHomeCandidates: ({ selectedAccountHomePath }) => [selectedAccountHomePath],
  findTranscript: async ({ providerSessionId, store, strictErrors }) => {
    const candidates: string[] = []
    const indexed = await readSessionDirs(join(dirname(store), 'session_index.jsonl'))
    const sessionDir = indexed.get(providerSessionId)
    if (sessionDir) {
      candidates.push(resolveSessionDir(sessionDir, store))
    } else {
      candidates.push(...(await scanSessionDirs(store, providerSessionId)))
    }
    for (const dir of candidates) {
      const wire = await wireTranscriptInSessionDir(dir)
      if (wire) {
        return wire
      }
    }
    if (strictErrors) {
      throw new Error(`kimi session ${providerSessionId} has no main wire transcript`)
    }
    return null
  }
})
