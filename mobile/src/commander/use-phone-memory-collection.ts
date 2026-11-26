import { useCallback, useEffect, useState } from 'react'
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
  perform
}: {
  client: RpcClient
  account: CommanderAccount
  handoffs: boolean
  searchable: boolean
  active: boolean
  perform: (work: () => Promise<void>) => Promise<void>
}) {
  const [filter, setFilter] = useState<HandoffFilter>({})
  const [listing, setListing] = useState<
    (PhonePages & { searchable: boolean; includeDeleted: boolean }) | null
  >(null)
  const collection = listing?.searchable === searchable ? listing : null
  const includeDeleted = collection?.includeDeleted ?? false
  const loadList = useCallback(
    (after?: string, withDeleted = includeDeleted, next?: HandoffFilter) =>
      perform(async () => {
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
  useEffect(() => {
    if (active && !collection) {
      void loadList()
    }
  }, [active, collection, loadList])
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
