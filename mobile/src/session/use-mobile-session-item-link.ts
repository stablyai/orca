import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useMobileTranslation } from '../i18n/use-mobile-translation'
import { useSessionRouteRequest } from './use-session-route-request'
import {
  parseMobileSessionItemTarget,
  type MobileSessionItemLink,
  type MobileSessionItemOutcome,
  type MobileSessionItemTarget
} from './mobile-session-item-target'

export function useMobileSessionItemLink(
  showToast: (message: string) => void
): MobileSessionItemLink {
  const arrival = useSessionRouteRequest('botItem')
  const t = useMobileTranslation()
  const [request, setRequest] = useState(() => {
    const target = parseMobileSessionItemTarget(arrival?.value)
    return { pending: target, selection: target }
  })
  const current = useRef(request.pending)
  const seen = useRef(arrival)
  useEffect(() => {
    if (arrival === seen.current) {
      return
    }
    seen.current = arrival
    const target = parseMobileSessionItemTarget(arrival?.value)
    current.current = target
    setRequest({ pending: target, selection: target })
  }, [arrival])
  const complete = useCallback(
    (target: MobileSessionItemTarget, outcome: MobileSessionItemOutcome) => {
      if (current.current !== target) {
        return
      }
      current.current = null
      setRequest((previous) =>
        previous.pending === target
          ? {
              pending: null,
              selection: outcome === 'missing' ? null : previous.selection
            }
          : previous
      )
      if (outcome === 'missing') {
        showToast(t('session.nativeChatView.linkedMessageMissing', 'Couldn’t find that message.'))
      }
    },
    [showToast, t]
  )
  return useMemo(() => {
    const target = request.pending
    return {
      selection: request.selection,
      navigation: target
        ? { target, complete: (outcome: MobileSessionItemOutcome) => complete(target, outcome) }
        : null
    }
  }, [complete, request])
}
