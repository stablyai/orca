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

export const executionOriginSchema = z.object({
  providerItemId: z.string(),
  epoch: z.string(),
  sequence: z.number(),
  ownerFence: z.number(),
  clientMessageId: z.string().optional()
})
export type JournalExecutionOrigin = z.infer<typeof executionOriginSchema>
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
  itemId: string,
  body: AgentJournalItemBody,
  writer: ExecutionWriter,
  exact = false
): { itemId?: string; ownerFence: number; opener?: string } {
  const currentId =
    exact && state.items.has(itemId) ? itemId : (state.aliases.get(itemId) ?? itemId)
  const current = state.items.get(currentId)
  let ownerFence =
    writer.executionOwner ??
    journalItemExecutionFence(state, currentId) ??
    writer.ownerFence ??
    writer.fence
  const turn = readAgentJournalTurn(body)
  if (
    !turn ||
    (exact && state.items.has(itemId)) ||
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
    return { itemId: next.itemId, item: next }
  }
  if (next.executionOrigin) {
    rememberOrigin(state, itemId, next.executionOrigin)
    return { itemId, item: { ...next, itemId } }
  }
  const address = journalExecutionAddress(state, itemId, next.body, writer)
  if (address.itemId !== undefined) {
    if (!state.items.has(address.itemId) && state.tombstones.has(address.itemId)) {
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
  rememberOrigin(state, canonical, origin)
  return { itemId: canonical, item: { ...next, itemId: canonical, executionOrigin: origin } }
}

function rememberOrigin(
  state: JournalReducerState,
  itemId: string,
  origin: JournalExecutionOrigin
): void {
  state.aliases.set(
    journalExecutionAlias(origin.providerItemId, origin.ownerFence, origin.clientMessageId),
    itemId
  )
  const headId = state.aliases.get(origin.providerItemId) ?? origin.providerItemId
  const head = state.items.get(headId)
  if (!head || head.itemId === itemId || !state.items.has(itemId)) {
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
      isJournalExecutionAlias(alias) &&
      (state.items.has(itemId) || state.tombstones.has(itemId))
    ) {
      state.aliases.set(alias, itemId)
    }
  }
}
