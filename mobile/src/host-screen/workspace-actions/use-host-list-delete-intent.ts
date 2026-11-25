import { useEffect, useState } from 'react'
import { useGlobalSearchParams, useLocalSearchParams, useRouter } from 'expo-router'
import { translate } from '../../i18n/mobile-i18n'
import { firstParam } from '../../navigation/route-param-reader'
import type { Worktree } from '../../worktree/workspace-list/workspace-list-types'
import type { HostScreenState } from '../use-host-screen-state'
import {
  findHostListDeleteRow,
  HOST_LIST_DELETE_INTENT_TTL_MS,
  HOST_LIST_DELETE_PARAM,
  takeHostListDeleteIntent,
  type HostListDeleteTarget
} from './host-list-delete-intent'

type DeleteParams = { [HOST_LIST_DELETE_PARAM]?: string | string[] }

/** Opens this list's own delete confirm for the row a session's ⋯ Delete named, once. */
export function useHostListDeleteIntent(args: {
  embedded: boolean
  hostId: string | undefined
  rows: readonly Worktree[]
  state: Pick<HostScreenState, 'setActionTarget' | 'setConfirmDelete' | 'setActionError'>
}): void {
  const { embedded, hostId, rows } = args
  const { setActionTarget, setConfirmDelete, setActionError } = args.state
  // A layout-mounted sidebar has no route params of its own; a stacked list reads only its own,
  // so a list hidden under another screen never takes the focused list's token.
  const globalParams = useGlobalSearchParams<DeleteParams>()
  const localParams = useLocalSearchParams<DeleteParams>()
  const token = firstParam((embedded ? globalParams : localParams)[HOST_LIST_DELETE_PARAM])
  const router = useRouter()
  const [claimed, setClaimed] = useState<{ target: HostListDeleteTarget; deadline: number } | null>(
    null
  )

  useEffect(() => {
    if (!token || !hostId) {
      return
    }
    const target = takeHostListDeleteIntent(token, hostId)
    // Spent either way, so Back or a reload to this entry cannot ask again.
    router.setParams({ [HOST_LIST_DELETE_PARAM]: '' })
    if (target) {
      setClaimed({ target, deadline: Date.now() + HOST_LIST_DELETE_INTENT_TTL_MS })
    }
  }, [hostId, router, token])

  useEffect(() => {
    if (!claimed) {
      return
    }
    const row = findHostListDeleteRow(rows, claimed.target)
    if (row) {
      setClaimed(null)
      setActionTarget(row)
      // A primary checkout opens the row menu instead, whose Delete explains why it can't.
      setConfirmDelete(row.isMainWorktree === true ? null : row)
      return
    }
    // The row may still be loading; a list that never shows it says so rather than opening nothing.
    const timer = setTimeout(
      () => {
        setClaimed(null)
        setActionError(
          translate(
            'hostScreen.deleteConfirm.rowNotFound',
            "Couldn't find that workspace. Try again from the list."
          )
        )
      },
      Math.max(0, claimed.deadline - Date.now())
    )
    return () => clearTimeout(timer)
  }, [claimed, rows, setActionTarget, setConfirmDelete, setActionError])
}
