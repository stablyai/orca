import { useCallback, useLayoutEffect, useRef, useState } from 'react'
import { useFocusEffect } from 'expo-router'
import { usePageBridgeClientIfPresent } from '../../transport/connection/client-context.web'
import {
  BRIDGE_PAGE_HEADER_GRANT,
  type BridgePageHeader
} from '../../mobile-web-shell/bridge/native-capabilities/bridge-page-header'
import { pageHeaderPayload, type PageHeaderRequest } from './page-header-payload'

type Sent = { key: string; header: BridgePageHeader }

/**
 * True while the shell draws this header natively, so the caller draws nothing. False on an older
 * shell, an ungranted route, outside the shell, for a null request, or for a header the shell can't
 * hold; the caller then draws its own bar. Only the focused screen's header holds the claim.
 */
export function usePageHeaderClaim(request: PageHeaderRequest | null): boolean {
  const client = usePageBridgeClientIfPresent()
  const granted =
    client?.getShellSession()?.grants.native.includes(BRIDGE_PAGE_HEADER_GRANT) === true
  const payload = granted && request !== null ? pageHeaderPayload(request) : null
  const key = payload === null ? null : JSON.stringify(payload.header)
  // One object per distinct header, so a re-render that changes nothing sends nothing.
  const [sent, setSent] = useState<Sent | null>(null)
  if ((sent?.key ?? null) !== key) {
    setSent(payload === null || key === null ? null : { key, header: payload.header })
  }
  const header = sent?.key === key ? (sent?.header ?? null) : (payload?.header ?? null)
  const handlers = useRef(payload?.handlers)
  const latestHeader = useRef(header)
  useLayoutEffect(() => {
    handlers.current = payload?.handlers
    latestHeader.current = header
  })
  const [focused, setFocused] = useState(false)
  useFocusEffect(
    useCallback(() => {
      setFocused(true)
      return () => setFocused(false)
    }, [])
  )
  const claimRef = useRef<ReturnType<NonNullable<typeof client>['claimPageHeader']> | null>(null)
  const claiming = client !== null && header !== null && focused
  useLayoutEffect(() => {
    const claimed = latestHeader.current
    if (!claiming || client === null || claimed === null) {
      return
    }
    const claim = client.claimPageHeader(claimed, (actionId) => handlers.current?.get(actionId)?.())
    claimRef.current = claim
    return () => {
      claimRef.current = null
      claim()
    }
  }, [client, claiming])
  useLayoutEffect(() => {
    if (header !== null) {
      claimRef.current?.update(header)
    }
  }, [header])
  return header !== null
}
