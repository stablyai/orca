import { setImmediate } from 'node:timers/promises'
import { agentJournalItemKey } from '../../../shared/agent-session/journal/agent-session-journal-item-key'
import type { NativeChatBlock } from '../../../shared/native-chat/native-chat-types'
import { digestPayload } from '../../native-chat/agent-session-journal/item-lifecycle/journal-payload-bounds'
import type { ClaudeImportItem } from '../../native-chat/agent-session-journal/history-import/journal-claude-import-worker-protocol'
import {
  isJournalHistoryItemsSizeFailure,
  type JournalHistoryItem
} from '../../native-chat/agent-session-journal/journal-history-items'
import type { AgentSessionJournalReads } from '../../native-chat/agent-session-journal/journal-reads'

const KEYS_PER_READ = 32
const SAVED_REPLY_BYTES = 1024 * 1024
const MARKER = /\n\[Orca: output truncated — (\d+) bytes total, digest ([0-9a-f]{12})\]$/

type Target = { previousBytes: number; replace: (value: unknown) => void }
type TargetIndex = Map<number, Map<string, Target[]>>
type Restoration = {
  entry: ClaudeImportItem
  position: number
  minimumBytes: number
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
    minimumBytes: entry.bytes + 1
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

type Candidate = { value: unknown; encoded: string; callId?: string; ordinal: number }

function savedCandidates(body: NonNullable<JournalHistoryItem['item']>['body']) {
  const byLength = new Map<number, Candidate[]>()
  let ordinal = 0
  const index = (value: unknown, encoded: string, callId?: string) => {
    const length = Buffer.byteLength(encoded)
    const candidates = byLength.get(length) ?? []
    byLength.set(length, candidates)
    candidates.push({ value, encoded, callId, ordinal: ordinal++ })
  }
  const tool = (call: Tool) => {
    if (call.callId) {
      index(call.input, JSON.stringify(call.input) ?? 'null', call.callId)
    }
  }
  if (body.kind === 'message') {
    for (const block of body.blocks) {
      if (block.type === 'text') {
        index(block.text, block.text)
      } else if (block.type === 'tool-result') {
        index(block.output, block.output)
      } else if (block.type === 'tool-call') {
        tool(block)
      }
    }
  } else if (body.kind === 'tool-call') {
    tool(body)
    if (body.output && !body.output.truncated) {
      index(body.output.head, body.output.head)
    }
  }
  return byLength
}

function matchSavedRow(
  item: NonNullable<JournalHistoryItem['item']>,
  plans: ReadonlySet<Restoration>,
  hashes: Map<number, string>,
  remainingBytes: number
): void {
  for (const [length, candidates] of savedCandidates(item.body)) {
    for (const candidate of candidates) {
      for (const plan of plans) {
        if (plan.minimumBytes > remainingBytes) {
          continue
        }
        const index = candidate.callId ? plan.inputs?.get(candidate.callId) : plan.text
        const bucket = index?.get(length)
        if (!bucket?.size) {
          continue
        }
        let digest = hashes.get(candidate.ordinal)
        if (digest === undefined) {
          digest = digestPayload(candidate.encoded)
          hashes.set(candidate.ordinal, digest)
        }
        const key = candidate.callId ? digest : digest.slice(0, 12)
        const targets = bucket.get(key)
        if (!targets) {
          continue
        }
        bucket.delete(key)
        const bytes = candidate.callId ? length : Buffer.byteLength(JSON.stringify(candidate.value))
        for (const target of targets) {
          plan.minimumBytes += bytes
          if (plan.minimumBytes > remainingBytes) {
            plan.entry.bytes = Infinity
            break
          }
          target.replace(candidate.value)
          plan.entry.bytes += bytes - target.previousBytes
        }
      }
    }
  }
}

async function* readSavedRows(
  keys: readonly string[],
  reads: Pick<AgentSessionJournalReads, 'historyItems'>,
  check: () => void,
  needed: (key: string) => boolean
): AsyncGenerator<readonly JournalHistoryItem[]> {
  check()
  const requested = keys.filter(needed)
  if (!requested.length) {
    return
  }
  let saved: readonly JournalHistoryItem[]
  try {
    saved = await reads.historyItems(requested, {
      includePlacement: false,
      maxReplyBytes: SAVED_REPLY_BYTES
    })
  } catch (error) {
    check()
    if (!isJournalHistoryItemsSizeFailure(error) || requested.length < 2) {
      throw error
    }
    const middle = Math.floor(requested.length / 2)
    yield* readSavedRows(requested.slice(0, middle), reads, check, needed)
    yield* readSavedRows(requested.slice(middle), reads, check, needed)
    return
  }
  check()
  yield saved
}

/** Restore only payloads whose full size and digest match the clipped import. */
export async function keepSavedRecoveryText(
  entries: ClaudeImportItem[],
  reads: Pick<AgentSessionJournalReads, 'historyItems'>,
  remainingBytes: number,
  check: () => void
): Promise<void> {
  const byKey = new Map<string, Restoration[]>()
  const plans: Restoration[] = []
  let cutoff = entries.length
  const trim = () => {
    // Unmatched fields can shrink when restored. Only stop on a lower bound.
    let bytes = 0
    for (const plan of plans) {
      bytes += plan.minimumBytes
      if (bytes > remainingBytes) {
        plan.entry.bytes = Infinity
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
  const needed = (key: string) => byKey.get(key)!.some((plan) => plan.position < cutoff)
  // Aliases can name the same saved revision even when they were split into different reads.
  const hashes = new Map<string, Map<number, string>>()
  const keys = [...byKey.keys()]
  for (let start = 0; start < keys.length; start += KEYS_PER_READ) {
    for await (const rows of readSavedRows(
      keys.slice(start, start + KEYS_PER_READ),
      reads,
      check,
      needed
    )) {
      const canonical = new Map<
        string,
        {
          item: NonNullable<JournalHistoryItem['item']>
          plans: Set<Restoration>
        }
      >()
      for (const row of rows) {
        if (!row.item || row.removed) {
          continue
        }
        const key = JSON.stringify([row.canonicalItemId, row.item.revision])
        const group = canonical.get(key) ?? { item: row.item, plans: new Set<Restoration>() }
        for (const plan of byKey.get(row.key) ?? []) {
          if (plan.position < cutoff) {
            group.plans.add(plan)
          }
        }
        canonical.set(key, group)
      }
      for (const [key, { item, plans }] of canonical) {
        const digests = hashes.get(key) ?? new Map<number, string>()
        matchSavedRow(item, plans, digests, remainingBytes)
        if (digests.size) {
          hashes.set(key, digests)
        }
      }
      trim()
      await setImmediate()
      check()
    }
  }
}
