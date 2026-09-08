import { useCallback } from 'react'
import type { Dispatch, SetStateAction } from 'react'
import {
  scheduleMobileTaskCopyFeedbackReset,
  type MobileTaskCopyFeedbackTimerRef
} from './mobile-task-copy-feedback-timer'
import type { HostTaskDeviceOperations } from './host-task-device-operations'

type MobileTaskCopyFeedbackOptions = {
  operations: HostTaskDeviceOperations
  resetTimerRef: MobileTaskCopyFeedbackTimerRef
  setCopiedKey: Dispatch<SetStateAction<string | null>>
  setError: Dispatch<SetStateAction<string>>
}

export function useMobileTaskCopyFeedback({
  operations,
  resetTimerRef,
  setCopiedKey,
  setError
}: MobileTaskCopyFeedbackOptions) {
  const copy = useCallback(
    async (key: string, value: string, errorMessage: string): Promise<void> => {
      try {
        await operations.copyText(value)
        setCopiedKey(key)
        scheduleMobileTaskCopyFeedbackReset(resetTimerRef, key, setCopiedKey)
      } catch (error) {
        setError(error instanceof Error ? error.message : errorMessage)
      }
    },
    [operations, resetTimerRef, setCopiedKey, setError]
  )

  return {
    copyTaskLink: useCallback(
      (key: string, url: string) => copy(key, url, 'Failed to copy link'),
      [copy]
    ),
    copyTextToClipboard: useCallback(
      (key: string, text: string) => copy(key, text, 'Failed to copy text'),
      [copy]
    )
  }
}
