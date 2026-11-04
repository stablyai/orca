import { z } from 'zod'
import {
  agentJournalItemKey,
  parseAgentJournalItemKey
} from '../../../shared/agent-session/journal/agent-session-journal-item-key'
import { readAgentJournalTurn } from '../../../shared/agent-session/lifecycle/agent-session-turn-record'
import type { AgentJournalItemBody } from '../../../shared/agent-session/journal/agent-session-journal-types'
import type { JournalReducerState } from './journal-reducer'
import type { JournalOwnedItem } from './journal-execution-interruption'
import { journalItemExecutionFence } from './journal-item-provenance'
import { journalItemRevisionIsStale } from './journal-item-revision'

export const executionOriginSchema = z.object({
  providerItemId: z.string(),
  epoch: z.string(),
  sequence: z.number(),
  ownerFence: z.number(),
  clientMessageId: z.string().optional()
})
export type JournalExecutionOrigin = z.infer<typeof executionOriginSchema>
export type JournalExecutionSelection =
  | { kind: 'exact'; itemId: string }
  | { kind: 'provider'; itemId: string }

type ExecutionWriter = { fence: number; ownerFence?: number; executionOwner?: number }
const EXECUTION_ALIAS = '@execution:'

export function isJournalExecutionItemKey(itemId: string): boolean {
  const identity = parseAgentJournalItemKey(itemId)
  return (
    identity?.provider === 'orca' &&
    'clientMessageId' in identity &&
    identity.clientMessageId.startsWith('execution:')
  )
}

export function journalExecutionAlias(
  providerItemId: string,
  fence: number,
  opener?: string
): string {
  return EXECUTION_ALIAS + JSON.stringify([providerItemId, fence, opener ?? null])
}
export function isJournalExecutionAlias(alias: string): boolean {
  return alias.startsWith(EXECUTION_ALIAS)
}

export function readJournalExecutionAlias(alias: string) {
  if (!isJournalExecutionAlias(alias)) {
    return undefined
  }
  try {
    const value = z
      .tuple([z.string(), z.number(), z.string().nullable()])
      .safeParse(JSON.parse(alias.slice(EXECUTION_ALIAS.length)))
    return value.success
      ? { providerItemId: value.data[0], ownerFence: value.data[1], opener: value.data[2] }
      : undefined
  } catch {
    return undefined
  }
}

/** Pure lookup is shared by write preparation and replay, before classifying any terminal result. */
export function journalExecutionAddress(
  state: JournalReducerState,
  selection: JournalExecutionSelection,
  body: AgentJournalItemBody,
  writer: ExecutionWriter
): { itemId?: string; ownerFence: number; opener?: string } {
  const { itemId } = selection
  const currentId = selection.kind === 'exact' ? itemId : (state.aliases.get(itemId) ?? itemId)
  const current = state.items.get(currentId)
  let ownerFence =
    writer.executionOwner ??
    journalItemExecutionFence(state, currentId) ??
    writer.ownerFence ??
    writer.fence
  const turn = readAgentJournalTurn(body)
  if (
    !turn ||
    selection.kind === 'exact' ||
    (current?.executionOrigin && itemId === current.itemId)
  ) {
    return { itemId: currentId, ownerFence }
  }
  const opener =
    turn.userItemId === undefined
      ? undefined
      : (state.aliases.get(turn.userItemId) ?? turn.userItemId)
  const client = opener?.startsWith('orca:') ? opener : undefined
  const previous = readAgentJournalTurn(current?.body)
  const priorOpener =
    previous?.userItemId === undefined
      ? undefined
      : (state.aliases.get(previous.userItemId) ?? previous.userItemId)
  const binding =
    previous &&
    priorOpener === undefined &&
    opener !== undefined &&
    (previous.state === 'running' ||
      previous.state === 'unverifiable' ||
      (state.items.get(opener)?.sequence ?? Infinity) <= current!.sequence)
  if (opener !== undefined && opener !== priorOpener && !binding) {
    ownerFence = writer.executionOwner ?? writer.ownerFence ?? writer.fence
  }
  const known = state.aliases.get(journalExecutionAlias(itemId, ownerFence, client))
  if (client !== undefined && known) {
    return { itemId: known, ownerFence, opener: client }
  }
  if (
    current &&
    journalItemExecutionFence(state, currentId) === ownerFence &&
    (opener === undefined || opener === priorOpener || binding)
  ) {
    return { itemId: currentId, ownerFence, opener: client }
  }
  if (known) {
    return { itemId: known, ownerFence, opener: client }
  }
  return {
    ...(current || state.tombstones.has(itemId) ? {} : { itemId }),
    ownerFence,
    opener: client
  }
}

export function journalExecutionOriginForItem(
  state: JournalReducerState,
  itemId: string
): JournalExecutionOrigin | undefined {
  const item = state.items.get(itemId)
  const turn = readAgentJournalTurn(item?.body)
  if (!item || !turn) {
    return undefined
  }
  if (!item.executionOrigin && (state.aliases.get(itemId) ?? itemId) === itemId) {
    return undefined
  }
  return (
    item.executionOrigin ?? {
      providerItemId: item.itemId,
      epoch: state.epoch,
      sequence: item.sequence,
      ownerFence: journalItemExecutionFence(state, item.itemId) ?? 0,
      ...(turn.userItemId === undefined
        ? {}
        : { clientMessageId: state.aliases.get(turn.userItemId) ?? turn.userItemId })
    }
  )
}

/** Provider addresses select a generation; canonical owner items are never overwritten by another. */
export function resolveJournalExecutionItem(
  state: JournalReducerState,
  itemId: string,
  next: JournalOwnedItem,
  writer: ExecutionWriter
): { itemId: string; item: JournalOwnedItem } | null {
  if (!readAgentJournalTurn(next.body)) {
    return journalItemRevisionIsStale(state, itemId, next.revision) ||
      journalItemRevisionIsStale(state, next.itemId, next.revision)
      ? null
      : { itemId: next.itemId, item: next }
  }
  if (next.executionOrigin) {
    if (journalItemRevisionIsStale(state, itemId, next.revision)) {
      return null
    }
    rememberOrigin(
      state,
      itemId,
      next.executionOrigin,
      next.executionOrigin.epoch === state.epoch &&
        next.executionOrigin.sequence === next.sequence &&
        !state.items.has(itemId)
    )
    return { itemId, item: { ...next, itemId } }
  }
  const address = journalExecutionAddress(state, { kind: 'provider', itemId }, next.body, writer)
  if (address.itemId !== undefined) {
    if (
      (!state.items.has(address.itemId) && state.tombstones.has(address.itemId)) ||
      journalItemRevisionIsStale(state, address.itemId, next.revision)
    ) {
      return null
    }
    state.aliases.set(
      journalExecutionAlias(itemId, address.ownerFence, address.opener),
      address.itemId
    )
    const origin = state.items.get(address.itemId)?.executionOrigin
    return {
      itemId: address.itemId,
      item: { ...next, itemId: address.itemId, ...(origin ? { executionOrigin: origin } : {}) }
    }
  }
  const origin: JournalExecutionOrigin = {
    providerItemId: itemId,
    epoch: state.epoch,
    sequence: next.sequence,
    ownerFence: address.ownerFence,
    ...(address.opener === undefined ? {} : { clientMessageId: address.opener })
  }
  const canonical = agentJournalItemKey({
    provider: 'orca',
    clientMessageId: `execution:${state.epoch}:${next.sequence}:${next.sequenceIndex ?? 0}`
  })
  if (journalItemRevisionIsStale(state, canonical, next.revision)) {
    return null
  }
  rememberOrigin(state, canonical, origin, true)
  return { itemId: canonical, item: { ...next, itemId: canonical, executionOrigin: origin } }
}

function rememberOrigin(
  state: JournalReducerState,
  itemId: string,
  origin: JournalExecutionOrigin,
  birth = false
): void {
  const ownerAlias = journalExecutionAlias(
    origin.providerItemId,
    origin.ownerFence,
    origin.clientMessageId
  )
  if (origin.clientMessageId !== undefined || !state.aliases.has(ownerAlias)) {
    state.aliases.set(ownerAlias, itemId)
  }
  const headId = state.aliases.get(origin.providerItemId) ?? origin.providerItemId
  const head = state.items.get(headId)
  const headOrigin = head?.executionOrigin
  const restoringNewer =
    !state.items.has(itemId) &&
    headOrigin?.epoch === origin.epoch &&
    origin.sequence >= headOrigin.sequence
  if (
    headId === itemId ||
    birth ||
    (!state.aliases.has(origin.providerItemId) && !head) ||
    restoringNewer
  ) {
    if (headId !== origin.providerItemId && headId !== itemId) {
      state.aliases.set(headId, itemId)
    }
    state.aliases.set(origin.providerItemId, itemId)
    state.aliases.set(journalExecutionAlias(origin.providerItemId, origin.ownerFence), itemId)
  }
}

export function carryJournalExecutionAliases(
  previous: JournalReducerState,
  state: JournalReducerState
): void {
  for (const [alias, itemId] of previous.aliases) {
    if (
      (isJournalExecutionAlias(alias) || previous.items.has(alias)) &&
      (state.items.has(itemId) || state.tombstones.has(itemId))
    ) {
      state.aliases.set(alias, itemId)
    }
  }
}
