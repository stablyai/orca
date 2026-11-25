import { useState } from 'react'
import type { MobileNativeChatPickerPresentation } from './MobileNativeChatSessionOptionPickers'

/** The composer's open option picker; each new request from the host opens its page. */
export function useMobileNativeChatPickerPresentation(request: { id: string } | null | undefined) {
  const [picker, setPicker] = useState<MobileNativeChatPickerPresentation | null>(null)
  const [lastRequest, setLastRequest] = useState(request)
  if (request && lastRequest !== request) {
    setLastRequest(request)
    setPicker({ page: request.id, refocus: false })
  }
  return [picker, setPicker] as const
}
