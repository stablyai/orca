import { useLayoutEffect, useMemo, useRef } from 'react'
import {
  mobileNativeChatRunDescriptors,
  type MobileNativeChatRunPresentation
} from '../../mobile-native-chat-run-descriptors'
import type { NativeChatMessage } from '../../../../../src/shared/native-chat-types'
import {
  assignNativeChatRowKeys as assignMobileNativeChatRowKeys,
  prepareNativeChatRowSources as prepareMobileNativeChatRowSources,
  type NativeChatAssignedRows as Assigned
} from '../../../../../src/shared/native-chat-row-keys'
export {
  assignNativeChatRowKeys as assignMobileNativeChatRowKeys,
  prepareNativeChatRowSources as prepareMobileNativeChatRowSources
} from '../../../../../src/shared/native-chat-row-keys'
export type {
  NativeChatRowSources as MobileNativeChatRowSources,
  NativeChatAssignedRows as MobileNativeChatAssignedRows
} from '../../../../../src/shared/native-chat-row-keys'

// Keep physical row keys when older messages join a folded run; the folded message id alone would remount it.
export type MobileNativeChatRowKeys = {
  scope: string
  sourceHead: string | undefined
  keyOf: (message: NativeChatMessage) => string
  current: (key: string) => string | undefined
  placement: (key: string) => string
}

export function useMobileNativeChatRowKeys(
  rows: readonly NativeChatMessage[],
  messages: readonly NativeChatMessage[],
  scope: string,
  presentation?: MobileNativeChatRunPresentation
): MobileNativeChatRowKeys & {
  runOwners: ReadonlyMap<string, string>
  runPlacements: ReadonlyMap<string, string>
} {
  // Commit snapshots only: discarded React renders must not become the next baseline.
  const committed = useRef<
    (Assigned & { scope: string; displayed: Assigned; serial: number }) | null
  >(null)
  const assigned = useMemo(() => {
    const previous = committed.current?.scope === scope ? committed.current : null
    const sourceOf = prepareMobileNativeChatRowSources(messages)
    const prepareSources = () => rows.map(sourceOf)
    const physical = assignMobileNativeChatRowKeys(
      previous,
      rows,
      messages,
      undefined,
      undefined,
      prepareSources
    )
    const runs = presentation ? mobileNativeChatRunDescriptors(presentation, sourceOf) : []
    const heads = runs.map((run) => run.row)
    let serial = previous?.serial ?? 0
    const displayed = {
      rows: heads,
      messages,
      ...assignMobileNativeChatRowKeys(
        previous?.displayed ?? null,
        heads,
        messages,
        () => `display-run:${serial++}`,
        undefined,
        () => runs.map((run) => run.sources)
      )
    }
    const runPlacements = new Map(Array.from(displayed.keyById, ([row, owner]) => [owner, row]))
    return { scope, rows, messages, prepareSources, ...physical, displayed, serial, runPlacements }
  }, [rows, messages, scope, presentation])
  useLayoutEffect(() => {
    committed.current = assigned
  }, [assigned])
  return useMemo(() => {
    let idByKey: Map<string, string> | undefined
    return {
      runOwners: assigned.displayed.keyById,
      runPlacements: assigned.runPlacements,
      scope: assigned.scope,
      sourceHead: assigned.messages[0]?.id,
      keyOf: (message: NativeChatMessage) => assigned.keyById.get(message.id) ?? message.id,
      current: (key: string) => (assigned.moved.has(key) ? assigned.moved.get(key) : key),
      placement: (key: string) =>
        (idByKey ??= new Map(Array.from(assigned.keyById, ([id, k]) => [k, id]))).get(key) ?? key
    }
  }, [assigned])
}
