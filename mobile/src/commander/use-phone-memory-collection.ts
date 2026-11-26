import { useCallback, useEffect, useRef, useState } from 'react'
import type {
  CommanderAccount,
  CommanderMemoryRevision
} from '../../../src/shared/commander/memory-contract'
import { humanRecurringAnswer } from '../../../src/shared/commander/recurring-answer'
import type { RpcClient } from '../transport/rpc/rpc-client-contract'
import { runRpcOperation } from '../transport/rpc/rpc-operation'
import type { HandoffFilter } from './PhoneHandoffSearch'
import { phoneListRead, type PhonePages } from './phone-memory-rpc'

export function usePhoneMemoryCollection({
  client,
  account,
  handoffs,
  searchable,
  active,
  busy,
  perform
}: {
  client: RpcClient
  account: CommanderAccount
  handoffs: boolean
  searchable: boolean
  active: boolean
  busy: boolean
  perform: (work: () => Promise<void>) => Promise<void>
}) {
  const [filter, setFilter] = useState<HandoffFilter>({})
  const [listing, setListing] = useState<
    (PhonePages & { searchable: boolean; includeDeleted: boolean }) | null
  >(null)
  const collection = listing?.searchable === searchable ? listing : null
  const includeDeleted = collection?.includeDeleted ?? false
  const requestedMode = useRef<boolean | null>(null)
  const loadList = useCallback(
    (after?: string, withDeleted = includeDeleted, next?: HandoffFilter) =>
      perform(async () => {
        requestedMode.current = searchable
        const result = await runRpcOperation(client, phoneListRead, {
          account,
          ...(handoffs ? { handoffsOnly: true } : {}),
          ...(searchable ? { order: 'recent' as const, ...(next ?? filter) } : {}),
          after,
          includeDeleted: withDeleted
        })
        if (next) {
          setFilter(next)
        }
        setListing((previous) =>
          after && previous?.searchable === searchable && previous.includeDeleted === withDeleted
            ? {
                ...result,
                searchable,
                includeDeleted: withDeleted,
                pages: [
                  ...new Map(
                    [...previous.pages, ...result.pages].map((page) => [page.pageId, page])
                  ).values()
                ]
              }
            : { ...result, searchable, includeDeleted: withDeleted }
        )
      }),
    [account, client, perform, includeDeleted, handoffs, searchable, filter]
  )
  // Wait for the shared RPC lock before trying a new mode. A failed load stays available for manual retry.
  useEffect(() => {
    if (!active || collection) {
      requestedMode.current = null
    } else if (!busy && requestedMode.current !== searchable) {
      void loadList()
    }
  }, [active, busy, collection, loadList, searchable])
  function savedPage(page: CommanderMemoryRevision) {
    if (searchable) {
      setListing(null)
      return
    }
    setListing((previous) =>
      previous
        ? {
            ...previous,
            pages: [
              ...(page.deleted && !previous.includeDeleted
                ? []
                : [{ ...page, recurringQuestion: humanRecurringAnswer(page)?.question }]),
              ...previous.pages.filter((p) => p.pageId !== page.pageId)
            ]
          }
        : null
    )
  }
  return { collection, includeDeleted, filter, loadList, savedPage }
}
