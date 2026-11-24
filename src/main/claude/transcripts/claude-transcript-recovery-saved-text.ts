import { setImmediate } from 'node:timers/promises'
import { agentJournalItemKey } from '../../../shared/agent-session/journal/agent-session-journal-item-key'
import type { NativeChatBlock } from '../../../shared/native-chat/native-chat-types'
import type { AgentJournalCursor } from '../../../shared/agent-session/journal/agent-session-journal-identity'
import { applyClaudeImportFieldFragment } from '../../native-chat/agent-session-journal/history-import/journal-claude-import-window'
import type { ClaudeImportItem } from '../../native-chat/agent-session-journal/history-import/journal-claude-import-worker-protocol'
import type {
  JournalClaudeRecoveryRead,
  JournalClaudeRecoveryReadResult
} from '../../native-chat/agent-session-journal/journal-claude-recovery-reads'
import type { AgentSessionJournalReads } from '../../native-chat/agent-session-journal/journal-reads'

const KEYS_PER_READ = 32
const MARKER = /\n\[Orca: output truncated — (\d+) bytes total, digest ([0-9a-f]{12})\]$/

type Target = { previousBytes: number; replace: (value: unknown) => void }
type TargetIndex = Map<number, Map<string, Target[]>>
type Fingerprint = Extract<
  JournalClaudeRecoveryReadResult,
  { kind: 'claude-recovery-fingerprints' }
>['fingerprints'][number]
type Slice = Extract<JournalClaudeRecoveryRead, { kind: 'claude-recovery-slices' }>
type RecoveryReads = Pick<
  AgentSessionJournalReads,
  'claudeRecoveryFingerprints' | 'claudeRecoverySlices'
>
type Match = { key: string; fingerprint: Fingerprint; targets: Target[] }

type Restoration = {
  entry: ClaudeImportItem
  position: number
  minimumBytes: number
  matches: Match[]
  text?: TargetIndex
  inputs?: Map<string, TargetIndex>
}
type Tool = { callId?: string; input: unknown }

function toolMarker(input: unknown) {
  if (
    input &&
    typeof input === 'object' &&
    'truncated' in input &&
    input.truncated === true &&
    'digest' in input &&
    typeof input.digest === 'string' &&
    'byteLength' in input &&
    typeof input.byteLength === 'number' &&
    'head' in input &&
    typeof input.head === 'string'
  ) {
    return { digest: input.digest, length: input.byteLength }
  }
  return undefined
}

function indexTarget(
  plan: Restoration,
  index: TargetIndex,
  length: number,
  digest: string,
  original: unknown,
  replace: Target['replace']
): void {
  const digests = index.get(length) ?? new Map<string, Target[]>()
  index.set(length, digests)
  const targets = digests.get(digest) ?? []
  digests.set(digest, targets)
  const previousBytes = Buffer.byteLength(JSON.stringify(original))
  targets.push({ previousBytes, replace })
  plan.minimumBytes -= previousBytes
}

function indexToolInput(plan: Restoration, tool: Tool): void {
  const marker = toolMarker(tool.input)
  if (!marker || !tool.callId) {
    return
  }
  const inputs = (plan.inputs ??= new Map())
  const index = inputs.get(tool.callId) ?? new Map()
  inputs.set(tool.callId, index)
  indexTarget(plan, index, marker.length, marker.digest, tool.input, (value) => {
    tool.input = value
  })
}

function indexBlock(plan: Restoration, block: NativeChatBlock): void {
  if (block.type === 'tool-call') {
    indexToolInput(plan, block)
  }
  const text =
    block.type === 'text' ? block.text : block.type === 'tool-result' ? block.output : undefined
  const marker = text !== undefined && MARKER.exec(text)
  if (marker) {
    indexTarget(plan, (plan.text ??= new Map()), Number(marker[1]), marker[2]!, text, (value) => {
      if (typeof value === 'string') {
        if (block.type === 'text') {
          block.text = value
        } else if (block.type === 'tool-result') {
          block.output = value
        }
      }
    })
  }
}

async function indexItem(
  entry: ClaudeImportItem,
  position: number,
  check: () => void
): Promise<Restoration> {
  const plan: Restoration = {
    entry,
    position,
    minimumBytes: entry.bytes + 1,
    matches: []
  }
  const { body } = entry.item
  if (body.kind === 'message') {
    for (let index = 0; index < body.blocks.length; index++) {
      if (index > 0 && index % 64 === 0) {
        await setImmediate()
        check()
      }
      indexBlock(plan, body.blocks[index]!)
    }
  } else if (body.kind === 'tool-call') {
    indexToolInput(plan, body)
  }
  return plan
}

function matchSavedField(plan: Restoration, key: string, fingerprint: Fingerprint): void {
  const { callId, byteLength, digest, jsonBytes } = fingerprint
  const index = callId ? plan.inputs?.get(callId) : plan.text
  const digests = index?.get(byteLength)
  const marker = callId ? digest : digest.slice(0, 12)
  const targets = digests?.get(marker)
  if (!targets) {
    return
  }
  digests!.delete(marker)
  plan.matches.push({ key, fingerprint, targets })
  for (const target of targets) {
    plan.minimumBytes += jsonBytes
    plan.entry.bytes += jsonBytes - target.previousBytes
  }
}

async function restoreMatches(
  kept: Restoration[],
  epoch: string,
  read: RecoveryReads['claudeRecoverySlices'],
  check: () => void
): Promise<void> {
  const rows = new Map<
    string,
    {
      row: Pick<Slice, 'key' | 'canonicalItemId' | 'revision'>
      fields: Map<string, { field: Fingerprint['field']; targets: Target[] }>
    }
  >()
  for (const plan of kept) {
    for (const { key, fingerprint, targets } of plan.matches) {
      const { field, canonicalItemId, revision } = fingerprint
      const rowKey = JSON.stringify([key, canonicalItemId, revision])
      const group = rows.get(rowKey) ?? {
        row: { key, canonicalItemId, revision },
        fields: new Map()
      }
      rows.set(rowKey, group)
      const fieldKey = JSON.stringify(field)
      const match = group.fields.get(fieldKey) ?? { field, targets: [] }
      group.fields.set(fieldKey, match)
      for (const target of targets) {
        match.targets.push(target)
      }
    }
  }
  for (const { row, fields } of rows.values()) {
    const matches = [...fields.values()]
    const addresses = matches.map(({ field }) => field)
    const values: Record<string, unknown> = {}
    let after: Slice['after'] | null = { ordinal: 0, offset: 0 }
    while (after) {
      check()
      const page = await read({
        epoch,
        ...row,
        fields: addresses,
        after
      })
      check()
      for (const fragment of page.fragments) {
        applyClaudeImportFieldFragment(values, fragment)
      }
      after = page.next
      await setImmediate()
    }
    for (const [ordinal, { targets }] of matches.entries()) {
      for (const target of targets) {
        target.replace(values[ordinal])
      }
      if (ordinal % 256 === 255) {
        await setImmediate()
        check()
      }
    }
  }
}

/** Resolve exact retained costs before reading any matched values. */
export async function keepSavedRecoveryText(
  entries: ClaudeImportItem[],
  reads: RecoveryReads,
  cursor: AgentJournalCursor,
  remainingBytes: number,
  check: () => void
): Promise<void> {
  const byKey = new Map<string, Restoration[]>()
  const plans: Restoration[] = []
  let cutoff = entries.length
  const trim = () => {
    // Unmatched fields can shrink when restored. Only stop on a lower bound.
    let bytes = 0
    for (const plan of plans.slice(0, cutoff)) {
      bytes += plan.minimumBytes
      if (bytes > remainingBytes) {
        cutoff = plan.position
        return
      }
    }
  }
  for (const [position, entry] of entries.entries()) {
    const plan = await indexItem(entry, position, check)
    plans.push(plan)
    if (!plan.text && !plan.inputs) {
      continue
    }
    for (const key of new Set([agentJournalItemKey(entry.item.identity)]).union(
      new Set(entry.keys)
    )) {
      const candidates = byKey.get(key) ?? []
      byKey.set(key, candidates)
      candidates.push(plan)
    }
  }
  trim()
  const keys = [...byKey.keys()]
  const needed = (key: string) => byKey.get(key)!.some((plan) => plan.position < cutoff)
  for (let start = 0; start < keys.length; start += KEYS_PER_READ) {
    const requested = keys.slice(start, start + KEYS_PER_READ).filter(needed)
    if (!requested.length) {
      continue
    }
    let after: Slice['after'] | null = { ordinal: 0, offset: 0 }
    while (after && requested.slice(after.ordinal).some(needed)) {
      check()
      const page = await reads.claudeRecoveryFingerprints({ cursor, keys: requested, after })
      check()
      for (const fingerprint of page.fingerprints) {
        const key = requested[fingerprint.keyIndex]!
        for (const plan of byKey.get(key)!) {
          if (plan.position < cutoff) {
            matchSavedField(plan, key, fingerprint)
          }
        }
      }
      trim()
      after = page.next
      await setImmediate()
    }
  }

  let bytes = 0
  let kept = 0
  for (const plan of plans.slice(0, cutoff)) {
    bytes += plan.entry.bytes + 1
    if (bytes > remainingBytes) {
      break
    }
    kept++
  }
  if (kept < entries.length) {
    entries[kept]!.bytes = Infinity
  }
  await restoreMatches(plans.slice(0, kept), cursor.epoch, reads.claudeRecoverySlices, check)
}
