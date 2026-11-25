import { useCallback, useEffect, useReducer, useRef } from 'react'
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

export type HostListDeleteIntentState = Pick<
  HostScreenState,
  | 'actionTarget'
  | 'confirmDelete'
  | 'confirmRemoveHost'
  | 'showWorkspaceOptions'
  | 'showNewWorktree'
  | 'search'
  | 'setActionTarget'
  | 'setConfirmDelete'
  | 'setActionError'
>

/** Opens this list's own delete confirm for the row a session's ⋯ Delete named, once. Returns the
 *  list's touch hook: any touch on the list means the user has moved on, and retires the claim. */
export function useHostListDeleteIntent(args: {
  embedded: boolean
  hostId: string | undefined
  connected: boolean
  rows: readonly Worktree[]
  bots: readonly HostBotListing[]
  /** The New bot sheet, which lives outside the list state. */
  newBotOpen: boolean
  state: HostListDeleteIntentState
}): () => boolean {
  const { embedded, hostId, connected, rows, bots, newBotOpen, state } = args
  const { search } = state
  const { setActionTarget, setConfirmDelete, setActionError } = state
  // Every sheet the list opens of its own: a claim never opens over, or after, another action.
  const busy =
    state.actionTarget !== null ||
    state.confirmDelete !== null ||
    state.confirmRemoveHost ||
    state.showWorkspaceOptions ||
    state.showNewWorktree ||
    newBotOpen
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
      search,
      connected,
      busy,
      rows,
      homes: hostListBotHomes(bots),
      now: Date.now()
    })
    claimRef.current = claim
    // Say why nothing opened, without covering another action's message.
    const sayOnce = (message: string) =>
      setActionError((current) => (current === '' ? message : current))
    if (step.kind === 'open') {
      setActionTarget(step.row)
      setConfirmDelete(step.row)
    } else if (step.kind === 'notFound') {
      sayOnce(
        translate(
          'hostScreen.deleteConfirm.rowNotFound',
          "Couldn't find that workspace. Try again from the list."
        )
      )
    } else if (step.kind === 'primary') {
      sayOnce(
        translate(
          'hostScreen.hostScreenOverlays.primaryWorktreeDeleteHint',
          "Primary worktree — can't be deleted. Remove the project instead."
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
    busy,
    connected,
    deadlineTick,
    hostId,
    pathname,
    router,
    rows,
    search,
    setActionError,
    setActionTarget,
    setConfirmDelete,
    token
  ])

  // Capture-phase responder check: never claims the touch, only retires a waiting claim.
  return useCallback(() => {
    claimRef.current = null
    return false
  }, [])
}
