import { homedir } from 'node:os'
import { basename, dirname, join } from 'node:path'

// Ante writes one folder per session under its sessions root:
// `<sessions>/<ses_ID>/{meta.json,events.jsonl}` plus optional `subagents/<id>/events.jsonl`.
// The `meta.json` -> `events.jsonl` mapping lives in the shared log-resource table.
const ANTE_METADATA_FILE_NAME = 'meta.json'

/** Only top-level session folders carry `meta.json`, which keeps subagent transcripts out of the list. */
export function isAnteSessionMetadataPath(filePath: string): boolean {
  return basename(filePath) === ANTE_METADATA_FILE_NAME
}

/** Folder name is the id `ante --resume` expects; `meta.json` `id` is preferred when present. */
export function anteSessionIdFromMetadataPath(filePath: string): string {
  return basename(dirname(filePath))
}

function expandLeadingUserHome(rawPath: string): string {
  return rawPath === '~' ? homedir() : rawPath.replace(/^~(?=[\\/])/, homedir())
}

/**
 * Explicit session roots outrank the agent home. Ante reads `ANTE_HOME` as its data root and
 * stores transcripts one level below it, so that env var must gain the `sessions` suffix.
 */
export function resolveAnteSessionsDir(override?: string): string {
  const explicit = override?.trim() || process.env.ANTE_SESSIONS_DIR?.trim()
  if (explicit) {
    return expandLeadingUserHome(explicit).replace(/[\\/]+$/, '')
  }
  const agentHome = process.env.ANTE_HOME?.trim()
  if (agentHome) {
    return join(expandLeadingUserHome(agentHome).replace(/[\\/]+$/, ''), 'sessions')
  }
  return join(homedir(), '.ante', 'sessions')
}
