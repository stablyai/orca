import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useMobileTranslation } from '../i18n/use-mobile-translation'
import { useSessionRouteRequest } from './use-session-route-request'
import { SESSION_PANE_INTENT_PARAM } from './session-pane-intent'
import {
  parseMobileSessionAccessTarget,
  parseMobileSessionItemTarget,
  type MobileSessionItemLink,
  type MobileSessionItemOutcome,
  type MobileSessionItemTarget
} from './mobile-session-item-target'

export function useMobileSessionItemLink(
  showToast: (message: string) => void
): MobileSessionItemLink {
  // Each pane request's intent brings its item or none; acknowledgements keep the intent.
  const arrival = useSessionRouteRequest('botItem', SESSION_PANE_INTENT_PARAM, 'paneKey')
  const t = useMobileTranslation()
  const [request, setRequest] = useState(() => {
    const target = parseMobileSessionItemTarget(arrival?.value)
    return { pending: target, selection: target }
  })
  const [access, setAccess] = useState(() => parseMobileSessionAccessTarget(arrival?.value))
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
    setAccess(parseMobileSessionAccessTarget(arrival?.value))
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
        : null,
      // Only this request's own ack clears it, so a newer push's request survives an older one's.
      access: access
        ? {
            requestId: access,
            reviewed: () => setAccess((current) => (current === access ? null : current))
          }
        : null
    }
  }, [access, complete, request])
}
