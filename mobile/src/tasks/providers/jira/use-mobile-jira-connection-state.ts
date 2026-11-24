import { useCallback, useLayoutEffect, useMemo, useRef, useState, type SetStateAction } from 'react'
import type { MobileJiraConnection } from './jira-mobile-connection'

export const EMPTY_MOBILE_JIRA_CONNECTION: MobileJiraConnection = {
  connected: false,
  sites: [],
  selection: null,
  credentialError: null,
  unavailableReason: null
}

export function useMobileJiraConnectionState(client: unknown, connState: string | undefined) {
  const owner = useMemo(() => ({ client, connState }), [client, connState])
  const committedOwner = useRef(owner)
  const [state, setState] = useState({ owner, value: EMPTY_MOBILE_JIRA_CONNECTION })
  useLayoutEffect(() => {
    committedOwner.current = owner
  }, [owner])
  const setConnection = useCallback(
    (update: SetStateAction<MobileJiraConnection>): void => {
      setState((current) => {
        if (committedOwner.current !== owner) {
          return current
        }
        const previous = current.owner === owner ? current.value : EMPTY_MOBILE_JIRA_CONNECTION
        return { owner, value: typeof update === 'function' ? update(previous) : update }
      })
    },
    [owner]
  )
  // A reused screen must not read another desktop's sites before its status arrives.
  const connection = state.owner === owner ? state.value : EMPTY_MOBILE_JIRA_CONNECTION
  return [connection, setConnection] as const
}
