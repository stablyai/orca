import { useCallback, useEffect, useRef, useState } from 'react'
import { useLocalSearchParams, useNavigation } from 'expo-router'
import { firstParam } from '../navigation/route-param-reader'
import { usePageBridgeClient } from '../transport/connection/client-context.web'
import type { BridgeClearableRouteParam } from '../mobile-web-shell/bridge/page-lifecycle/bridge-route-update'

/** Keep an arrival after its route acknowledgement, until the consumer applies it. */
export function useSessionRouteRequest(param: BridgeClearableRouteParam) {
  const client = usePageBridgeClient()
  const navigation = useNavigation<{ setParams: (params: Record<string, undefined>) => void }>()
  const urlValue =
    firstParam(useLocalSearchParams<Record<string, string | string[]>>()[param]) || null
  const seed = client.getShellSession()?.route?.params?.[param] || urlValue
  const [request, setRequest] = useState<{ value: string } | null>(() =>
    seed ? { value: seed } : null
  )
  const applied = useRef(seed)
  const mountUrlValue = useRef(urlValue)
  const record = useCallback((value: string, fromUrl = false) => {
    if (fromUrl || applied.current !== value) {
      applied.current = value
      setRequest({ value })
    }
  }, [])

  useEffect(() => {
    if (urlValue === null) {
      mountUrlValue.current = null
      return
    }
    if (urlValue !== mountUrlValue.current) {
      record(urlValue, true)
    }
    navigation.setParams({ [param]: undefined })
  }, [navigation, param, record, urlValue])

  useEffect(() => {
    const initial = client.getShellSession()?.route?.params?.[param]
    if (initial) {
      client.clearRouteParam(param, initial)
    }
    return client.onRouteUpdate((route) => {
      const value = route?.params?.[param] ?? ''
      if (value === '') {
        applied.current = null
        return
      }
      client.clearRouteParam(param, value)
      record(value)
    })
  }, [client, param, record])
  return request
}
