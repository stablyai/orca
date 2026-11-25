import { useEffect, useReducer, useRef } from 'react'
import { useGlobalSearchParams, useLocalSearchParams, usePathname, useRouter } from 'expo-router'
import { translate } from '../../i18n/mobile-i18n'
import { firstParam } from '../../navigation/route-param-reader'
import type { HostBotListing } from '../../bots/host-bot-listing'
import type { Worktree } from '../../worktree/workspace-list/workspace-list-types'
import type { HostScreenState } from '../use-host-screen-state'
import {
  advanceHostListDeleteClaim,
  HOST_LIST_DELETE_PARAM,
  hostListBotHomes,
  type HostListDeleteClaim
} from './host-list-delete-intent'

type DeleteParams = { [HOST_LIST_DELETE_PARAM]?: string | string[] }

/** Opens this list's own delete confirm for the row a session's ⋯ Delete named, once. */
export function useHostListDeleteIntent(args: {
  embedded: boolean
  hostId: string | undefined
  connected: boolean
  rows: readonly Worktree[]
  bots: readonly HostBotListing[]
  state: Pick<
    HostScreenState,
    'actionTarget' | 'confirmDelete' | 'setActionTarget' | 'setConfirmDelete' | 'setActionError'
  >
}): void {
  const { embedded, hostId, connected, rows, bots, state } = args
  const { setActionTarget, setConfirmDelete, setActionError } = state
  const overlayBusy = state.actionTarget !== null || state.confirmDelete !== null
  // A layout-mounted sidebar has no route params of its own; a stacked list reads only its own,
  // so a list hidden under another screen never takes the focused list's token.
  const globalParams = useGlobalSearchParams<DeleteParams>()
  const localParams = useLocalSearchParams<DeleteParams>()
  const token = firstParam((embedded ? globalParams : localParams)[HOST_LIST_DELETE_PARAM])
  const pathname = usePathname()
  const router = useRouter()
  // Read and replaced within one pass, so a new tap's token supersedes an older claim before its row can open.
  const claimRef = useRef<HostListDeleteClaim | null>(null)
  // A pass before setParams lands sees the same spent token; presenting it again would drop the claim.
  const presentedRef = useRef('')
  const [deadlineTick, tick] = useReducer((n: number) => n + 1, 0)

  useEffect(() => {
    const presented = token !== '' && token !== presentedRef.current ? token : ''
    if (presented) {
      presentedRef.current = presented
      // Spent either way, so Back or a reload to this entry cannot ask again.
      router.setParams({ [HOST_LIST_DELETE_PARAM]: '' })
    }
    const { claim, step } = advanceHostListDeleteClaim(claimRef.current, {
      token: presented,
      hostId,
      pathname,
      connected,
      overlayBusy,
      rows,
      homes: hostListBotHomes(bots),
      now: Date.now()
    })
    claimRef.current = claim
    if (step.kind === 'open') {
      setActionTarget(step.row)
      // A primary checkout opens the row menu instead, whose Delete explains why it can't.
      setConfirmDelete(step.row.isMainWorktree === true ? null : step.row)
    } else if (step.kind === 'notFound') {
      setActionError(
        translate(
          'hostScreen.deleteConfirm.rowNotFound',
          "Couldn't find that workspace. Try again from the list."
        )
      )
    }
    if (!claim) {
      return
    }
    // Wake at the tap's deadline; the next pass rechecks ownership before saying anything.
    const timer = setTimeout(tick, Math.max(0, claim.deadline - Date.now() + 1))
    return () => clearTimeout(timer)
  }, [
    bots,
    connected,
    deadlineTick,
    hostId,
    overlayBusy,
    pathname,
    router,
    rows,
    setActionError,
    setActionTarget,
    setConfirmDelete,
    token
  ])
}
