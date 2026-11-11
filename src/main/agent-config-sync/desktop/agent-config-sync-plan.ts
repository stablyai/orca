import {
  AGENT_CONFIG_LIMITS,
  agentConfigItemKey,
  type AgentConfigItemKind,
  type AgentConfigItemPayload,
  type AgentConfigItemRef,
  type AgentConfigSyncPlanResult,
  type AgentConfigSyncPutResult,
  type AgentConfigSyncRow
} from '../../../shared/agent-config-sync/agent-config-sync-contract'
import type { AgentConfigDigestEntry } from '../agent-config-digest'
import type { LocalAgentConfigItem } from './local-agent-config-read'

export type DesiredAgentConfigItem = AgentConfigItemRef & {
  key: string
  files: AgentConfigDigestEntry[]
}

export type AgentConfigSyncPlan = {
  rows: AgentConfigSyncRow[]
  desired: DesiredAgentConfigItem[]
}

/** The other agent's kind an item converts to; the formats match (SKILL.md folders, Markdown prompts). */
function counterpartKind(item: LocalAgentConfigItem): AgentConfigItemKind | null {
  switch (item.kind) {
    case 'claude-skill':
      return 'agents-skill'
    case 'agents-skill':
    case 'codex-skill':
      return 'claude-skill'
    case 'claude-command':
      // Codex prompts are flat: a namespaced command has no Codex name.
      return item.name.includes('/') ? null : 'codex-prompt'
    case 'codex-prompt':
      return 'claude-command'
  }
}

/** Kinds that already give the other agent an item of that name. */
const NATIVE_FOR: Record<AgentConfigItemKind, AgentConfigItemKind[]> = {
  'agents-skill': ['agents-skill', 'codex-skill'],
  'codex-skill': ['agents-skill', 'codex-skill'],
  'claude-skill': ['claude-skill'],
  'claude-command': ['claude-command'],
  'codex-prompt': ['codex-prompt']
}

function rowOf(item: LocalAgentConfigItem, key: string, included: boolean): AgentConfigSyncRow {
  return {
    key,
    scope: item.scope,
    kind: item.kind,
    name: item.name,
    bytes: item.bytes,
    fileCount: item.fileCount,
    withheldFiles: item.withheldFiles,
    ...(item.digest ? { digest: item.digest } : {}),
    included,
    state: 'pending'
  }
}

/** What to send and how each local item shows, before the host answers. */
export function planAgentConfigSync(args: {
  items: readonly LocalAgentConfigItem[]
  excluded: ReadonlySet<string>
  shareAcrossAgents: boolean
}): AgentConfigSyncPlan {
  const rows: AgentConfigSyncRow[] = []
  const candidates: { row: AgentConfigSyncRow; item: LocalAgentConfigItem }[] = []
  const names = new Set(
    args.items.filter((item) => item.scope === 'user').map((item) => `${item.kind}:${item.name}`)
  )
  const converted = new Set<string>()
  for (const item of args.items) {
    const key = agentConfigItemKey(item.scope, item.kind, item.name)
    const included = !args.excluded.has(key)
    const row = rowOf(item, key, included)
    if (item.skipReason) {
      rows.push({ ...row, state: 'skipped', skipReason: item.skipReason })
      continue
    }
    if (!included) {
      rows.push({ ...row, state: 'skipped', skipReason: 'turned-off' })
      continue
    }
    rows.push(row)
    candidates.push({ row, item })
    const target = args.shareAcrossAgents && item.scope === 'user' ? counterpartKind(item) : null
    if (
      !target ||
      NATIVE_FOR[target].some((kind) => names.has(`${kind}:${item.name}`)) ||
      converted.has(`${target}:${item.name}`)
    ) {
      continue
    }
    // One copy per name: .agents and the older .codex skills folder can both hold it.
    converted.add(`${target}:${item.name}`)
    const copy = { ...item, kind: target }
    const copyRow: AgentConfigSyncRow = {
      ...rowOf(copy, agentConfigItemKey('user', target, item.name), true),
      convertedFrom: key
    }
    rows.push(copyRow)
    candidates.push({ row: copyRow, item: copy })
  }
  // Natives first, so a copy is what falls past the limit.
  candidates.sort((a, b) => Number(!!a.row.convertedFrom) - Number(!!b.row.convertedFrom))
  const desired: DesiredAgentConfigItem[] = []
  let total = 0
  for (const { row, item } of candidates) {
    if (
      desired.length >= AGENT_CONFIG_LIMITS.items ||
      total + item.bytes > AGENT_CONFIG_LIMITS.totalBytes ||
      !item.digest
    ) {
      row.state = 'skipped'
      row.skipReason = 'over-limit'
      continue
    }
    total += item.bytes
    desired.push({
      key: row.key,
      scope: item.scope,
      kind: item.kind,
      name: item.name,
      digest: item.digest,
      files: item.files
    })
  }
  return { rows, desired }
}

/** Put calls that each stay under one item's byte budget (and so under the RPC frame). */
export function agentConfigPutBatches(
  items: readonly DesiredAgentConfigItem[]
): AgentConfigItemPayload[][] {
  const batches: AgentConfigItemPayload[][] = []
  let current: AgentConfigItemPayload[] = []
  let bytes = 0
  for (const item of items) {
    const size = item.files.reduce((sum, file) => sum + file.bytes.length, 0)
    if (
      current.length > 0 &&
      (bytes + size > AGENT_CONFIG_LIMITS.itemBytes ||
        current.length >= AGENT_CONFIG_LIMITS.putItems)
    ) {
      batches.push(current)
      current = []
      bytes = 0
    }
    current.push({
      scope: item.scope,
      kind: item.kind,
      name: item.name,
      digest: item.digest,
      files: item.files.map((file) => ({
        path: file.path,
        executable: file.executable,
        base64: file.bytes.toString('base64')
      }))
    })
    bytes += size
  }
  if (current.length > 0) {
    batches.push(current)
  }
  return batches
}

const SYNCED_OUTCOMES: ReadonlySet<string> = new Set(['added', 'updated', 'unchanged'])

/** Rows after the host's plan and puts answered. */
export function applyAgentConfigSyncResults(
  rows: readonly AgentConfigSyncRow[],
  plan: AgentConfigSyncPlanResult,
  put: AgentConfigSyncPutResult['items']
): AgentConfigSyncRow[] {
  return rows.map((row) => {
    if (row.state === 'skipped') {
      return row
    }
    const outcome = put[row.key] ?? plan.items[row.key]
    if (!outcome) {
      return row
    }
    const synced = SYNCED_OUTCOMES.has(outcome)
    return { ...row, state: synced ? 'synced' : 'skipped', outcome }
  })
}
