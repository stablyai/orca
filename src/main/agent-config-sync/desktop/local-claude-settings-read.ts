import { readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'
import {
  AGENT_CONFIG_LIMITS,
  AGENT_CONFIG_SELF_PATH,
  AGENT_CONFIG_SETTINGS_NAME,
  CLAUDE_SETTINGS_PERMISSION_LISTS,
  CLAUDE_SETTINGS_SCALAR_KEYS,
  ClaudeSettingsPayload
} from '../../../shared/agent-config-sync/agent-config-sync-contract'
import { agentConfigDigest } from '../agent-config-digest'
import { hasSecretContent } from './agent-config-secret-scan'
import type { LocalAgentConfigItem } from './local-agent-config-read'

/** A rule that names a path on this computer (/Users/…, /home/…, C:\\…) means nothing in the sandbox. */
const MACHINE_PATH = /(?:^|[\s("'=:,])(?:\/Users\/|\/home\/|\/private\/|\/Volumes\/|[A-Za-z]:\\)/

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const shareable = (value: string): boolean =>
  !MACHINE_PATH.test(value) && !hasSecretContent(Buffer.from(value))

/** Only the allowlisted keys, minus anything machine-specific or secret-shaped.
 * `dropped` counts what was left out because of a path or a key shape. */
export function filterClaudeSettings(raw: unknown): {
  payload: ClaudeSettingsPayload
  dropped: number
} {
  const payload: Record<string, unknown> = {}
  let dropped = 0
  if (!isRecord(raw)) {
    return { payload: {}, dropped }
  }
  for (const key of CLAUDE_SETTINGS_SCALAR_KEYS) {
    const value = raw[key]
    if (value === undefined) {
      continue
    }
    if (typeof value === 'string' && !shareable(value)) {
      dropped += 1
      continue
    }
    payload[key] = value
  }
  if (isRecord(raw.permissions)) {
    const permissions: Record<string, string[]> = {}
    for (const list of CLAUDE_SETTINGS_PERMISSION_LISTS) {
      const entries = raw.permissions[list]
      if (!Array.isArray(entries)) {
        continue
      }
      const kept = entries.filter(
        (entry): entry is string => typeof entry === 'string' && entry.length > 0
      )
      const clean = kept.filter(shareable)
      dropped += kept.length - clean.length
      if (clean.length > 0) {
        permissions[list] = [...new Set(clean)].slice(0, 500)
      }
    }
    if (Object.keys(permissions).length > 0) {
      payload.permissions = permissions
    }
  }
  // Anything the schema rejects (a wrong type, an oversized value) is dropped as a whole.
  const parsed = ClaudeSettingsPayload.safeParse(payload)
  return parsed.success ? { payload: parsed.data, dropped } : { payload: {}, dropped: dropped + 1 }
}

/** ~/.claude/settings.json as one item carrying only what may sync. settings.local.json never does. */
export async function readClaudeSettings(claudeDir: string): Promise<LocalAgentConfigItem[]> {
  const path = join(claudeDir, 'settings.json')
  const info = await stat(path).catch(() => null)
  if (!info?.isFile()) {
    return []
  }
  const base = {
    scope: 'user' as const,
    kind: 'claude-settings' as const,
    name: AGENT_CONFIG_SETTINGS_NAME,
    withheldFiles: 0,
    fileCount: 1
  }
  if (info.size > AGENT_CONFIG_LIMITS.fileBytes) {
    return [{ ...base, files: [], bytes: info.size, digest: null, skipReason: 'too-large' }]
  }
  let raw: unknown
  try {
    raw = JSON.parse(await readFile(path, 'utf8'))
  } catch {
    return [{ ...base, files: [], bytes: info.size, digest: null, skipReason: 'invalid' }]
  }
  const { payload, dropped } = filterClaudeSettings(raw)
  if (Object.keys(payload).length === 0) {
    return []
  }
  const bytes = Buffer.from(`${JSON.stringify(payload, null, 2)}\n`)
  const files = [{ path: AGENT_CONFIG_SELF_PATH, executable: false, bytes }]
  return [
    {
      ...base,
      files,
      bytes: bytes.length,
      digest: agentConfigDigest(files),
      ...(dropped > 0 ? { localRefs: dropped } : {})
    }
  ]
}
