import { useCallback, useEffect, useRef, useState } from 'react'
import { useLocalSearchParams, useNavigation } from 'expo-router'
import { firstParam } from '../navigation/route-param-reader'
import { usePageBridgeClient } from '../transport/connection/client-context.web'
import type { BridgeClearableRouteParam } from '../mobile-web-shell/bridge/page-lifecycle/bridge-route-update'

/** Keep an arrival after its route acknowledgement, until the consumer applies it. With
 *  `intentParam`, each new intent delivers its own `param`, or an empty request when it has none,
 *  ending an earlier one; acknowledgements and echoes carry the same intent and change nothing. A
 *  shell update without an intent counts as new when its `paneParam` request changed. */
export function useSessionRouteRequest(
  param: BridgeClearableRouteParam,
  intentParam?: string,
  paneParam?: BridgeClearableRouteParam
) {
  const client = usePageBridgeClient()
  const navigation = useNavigation<{ setParams: (params: Record<string, undefined>) => void }>()
  const search = useLocalSearchParams<Record<string, string | string[]>>()
  const urlValue = firstParam(search[param]) || null
  const urlIntent = (intentParam && firstParam(search[intentParam])) || null
  const shellParams = client.getShellSession()?.route?.params
  const shellIntent = (intentParam && shellParams?.[intentParam]) || null
  // A shell route naming an intent is the latest request: its item, or none, beats the boot URL's.
  const seed = shellParams?.[param] || (shellIntent ? null : urlValue)
  const [request, setRequest] = useState<{ value: string } | null>(() =>
    seed ? { value: seed } : null
  )
  const applied = useRef(seed)
  const mountUrlValue = useRef(urlValue)
  const mountUrlIntent = useRef(urlIntent)
  const intent = useRef(shellIntent || urlIntent)
  const pane = useRef((paneParam && shellParams?.[paneParam]) || null)
  const paneChanges = useRef(0)
  const record = useCallback((value: string, fromUrl = false) => {
    if (fromUrl || applied.current !== value) {
      applied.current = value
      setRequest({ value })
    }
  }, [])
  // True when `next` starts a new intent; one that names no value ends the earlier request.
  const startsIntent = useCallback((next: string | null, value: string | null) => {
    if (!next || next === intent.current) {
      return false
    }
    intent.current = next
    if (!value) {
      applied.current = null
      // oxlint-disable-next-line react-doctor/no-adjust-state-on-prop-change -- Why: a one-shot request handed over by the router URL or the shell bridge, recorded once per intent as its URL param is cleared, like `record`.
      setRequest({ value: '' })
    }
    return true
  }, [])

  useEffect(() => {
    // The URL's intent at mount is covered by the seed; only a later one is a new request.
    const fresh = urlIntent !== mountUrlIntent.current && startsIntent(urlIntent, urlValue)
    if (urlValue === null) {
      mountUrlValue.current = null
      return
    }
    if (fresh || urlValue !== mountUrlValue.current) {
      record(urlValue, true)
    }
    navigation.setParams({ [param]: undefined })
  }, [navigation, param, record, startsIntent, urlIntent, urlValue])

  useEffect(() => {
    const initial = client.getShellSession()?.route?.params?.[param]
    if (initial) {
      client.clearRouteParam(param, initial)
    }
    return client.onRouteUpdate((route) => {
      const value = route?.params?.[param] ?? ''
      const routeIntent = (intentParam && route?.params?.[intentParam]) || null
      const routePane = (paneParam && route?.params?.[paneParam]) || null
      // Without an intent, a changed pane request is new; clearing or repeating it is not.
      const paneChanged = routePane !== null && routePane !== pane.current
      pane.current = routePane
      const fresh = routeIntent
        ? startsIntent(routeIntent, value)
        : paneChanged && startsIntent(`pane:${(paneChanges.current += 1)}`, value)
      if (value === '') {
        applied.current = null
        return
      }
      client.clearRouteParam(param, value)
      if (fresh) {
        applied.current = null
      }
      record(value)
    })
  }, [client, intentParam, paneParam, param, record, startsIntent])
  return request
}
