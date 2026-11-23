import { useCallback, useLayoutEffect, useMemo, useRef, useState, type SetStateAction } from 'react'
import {
  DISCONNECTED_CLICKUP_CONNECTION,
  type MobileClickUpConnection
} from './clickup-mobile-connection'

export function useMobileClickUpConnectionState(client: unknown, connState: string | undefined) {
  const owner = useMemo(() => ({ client, connState }), [client, connState])
  const committedOwner = useRef(owner)
  const [state, setState] = useState({ owner, value: DISCONNECTED_CLICKUP_CONNECTION })
  useLayoutEffect(() => {
    committedOwner.current = owner
  }, [owner])
  const setConnection = useCallback(
    (update: SetStateAction<MobileClickUpConnection>): void => {
      setState((current) => {
        if (committedOwner.current !== owner) {
          return current
        }
        const previous = current.owner === owner ? current.value : DISCONNECTED_CLICKUP_CONNECTION
        return { owner, value: typeof update === 'function' ? update(previous) : update }
      })
    },
    [owner]
  )
  // A reused screen must not read another desktop's workspaces before its status arrives.
  const connection = state.owner === owner ? state.value : DISCONNECTED_CLICKUP_CONNECTION
  return [connection, setConnection] as const
}
