import { mkdir, readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { errnoCodeOrUnknown } from '../../../shared/errno-code'
import {
  CLAUDE_SETTINGS_PERMISSION_LISTS,
  CLAUDE_SETTINGS_SCALAR_KEYS,
  ClaudeSettingsPayload,
  type AgentConfigPutOutcome
} from '../../../shared/agent-config-sync/agent-config-sync-contract'
import {
  writeFileAtomically,
  writeFileAtomicallyIfUnchanged
} from '../../filesystem/atomic-file-publication'
import type { AgentConfigHomes } from '../agent-config-roots'
import { mergeClaudeSettings, type ClaudeSettingsLedger } from './claude-settings-merge'

// Claude Code rewrites settings.json now and then; retry a lost race instead of clobbering it.
const WRITE_ATTEMPTS = 4

const settingsPath = (homes: AgentConfigHomes): string => join(homes.claudeDir, 'settings.json')
const ledgerPathOf = (ledgerDir: string, syncer: string): string =>
  join(ledgerDir, `agent-config-settings-${syncer}.json`)

async function readText(path: string): Promise<string | null> {
  try {
    return await readFile(path, 'utf8')
  } catch (error) {
    if (errnoCodeOrUnknown(error) === 'ENOENT') {
      return null
    }
    throw error
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

async function readSettingsLedger(path: string): Promise<ClaudeSettingsLedger> {
  const ledger: ClaudeSettingsLedger = { scalars: {}, permissions: {} }
  let raw: unknown
  try {
    raw = JSON.parse((await readText(path)) ?? '{}')
  } catch {
    // Damaged: this computer owns nothing in settings.json it can prove.
    return ledger
  }
  if (!isRecord(raw)) {
    return ledger
  }
  const scalars = raw.scalars
  if (isRecord(scalars)) {
    for (const key of CLAUDE_SETTINGS_SCALAR_KEYS) {
      if (key in scalars) {
        ledger.scalars[key] = scalars[key]
      }
    }
  }
  const permissions = raw.permissions
  if (isRecord(permissions)) {
    for (const list of CLAUDE_SETTINGS_PERMISSION_LISTS) {
      const rules = permissions[list]
      if (Array.isArray(rules)) {
        ledger.permissions[list] = rules.filter((rule): rule is string => typeof rule === 'string')
      }
    }
  }
  return ledger
}

/** Merge (or, with an empty payload, unmerge) this computer's settings into the sandbox's file. */
export async function applyClaudeSettings(
  payload: ClaudeSettingsPayload,
  deps: { homes: AgentConfigHomes; ledgerDir: string; syncer: string }
): Promise<AgentConfigPutOutcome | 'removed' | 'unchanged'> {
  const path = settingsPath(deps.homes)
  const ledgerPath = ledgerPathOf(deps.ledgerDir, deps.syncer)
  const ledger = await readSettingsLedger(ledgerPath)
  const hadAny =
    Object.keys(ledger.scalars).length > 0 || Object.keys(ledger.permissions).length > 0
  for (let attempt = 0; attempt < WRITE_ATTEMPTS; attempt += 1) {
    const text = await readText(path)
    const merged = mergeClaudeSettings(text, payload, ledger)
    if (merged.kind === 'unreadable') {
      return 'kept-host'
    }
    if (merged.text !== null) {
      await mkdir(dirname(path), { recursive: true })
      if (!writeFileAtomicallyIfUnchanged(path, text, merged.text)) {
        continue
      }
    }
    await mkdir(deps.ledgerDir, { recursive: true })
    writeFileAtomically(ledgerPath, `${JSON.stringify(merged.ledger, null, 2)}\n`, { mode: 0o600 })
    const empty = Object.keys(payload).length === 0
    if (empty) {
      return hadAny ? 'removed' : 'unchanged'
    }
    return merged.text === null ? 'unchanged' : hadAny ? 'updated' : 'added'
  }
  return 'failed'
}

/** The payload a put carries for settings: JSON of allowlisted keys, checked again here. */
export function parseSettingsPayload(bytes: Buffer): ClaudeSettingsPayload | null {
  try {
    const parsed = ClaudeSettingsPayload.safeParse(JSON.parse(bytes.toString('utf8')))
    return parsed.success ? parsed.data : null
  } catch {
    return null
  }
}
