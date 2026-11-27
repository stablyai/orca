import { useCallback, useEffect, useMemo, useRef } from 'react'

/** One thing the user does to the page: type text, press a key, or (any other command) tap. */
export type PageInputStep = { text: string } | { key: string } | { run: () => Promise<unknown> }
type QueuedPageInput = PageInputStep & { settle: (delivered: boolean) => void }

export type MobileBrowserPageInput = {
  /** Resolves false when any of the steps didn't reach the page. */
  queue: (steps: readonly PageInputStep[]) => Promise<boolean>
  /** Called as a tap or navigation is queued, since each may move the page's focus to another field. */
  onFocusMove: (listener: () => void) => () => void
}

type PageInputSenders = {
  sendText: (text: string) => Promise<boolean>
  sendKeypress: (key: string) => Promise<boolean>
  mountedRef: { current: boolean }
}

/**
 * Typing and taps go to the page one at a time and in order: a tap on the next field must not land
 * before the text still being typed into this one.
 */
export function useMobileBrowserPageInputQueue({
  sendText,
  sendKeypress,
  mountedRef
}: PageInputSenders): MobileBrowserPageInput {
  const inputQueueRef = useRef<{ steps: QueuedPageInput[]; pumping: boolean }>({
    steps: [],
    pumping: false
  })
  const focusListenersRef = useRef(new Set<() => void>())
  const sendersRef = useRef({ sendText, sendKeypress })
  useEffect(() => {
    sendersRef.current = { sendText, sendKeypress }
  }, [sendKeypress, sendText])

  const pumpPageInput = useCallback(async () => {
    const queue = inputQueueRef.current
    if (queue.pumping) {
      return
    }
    queue.pumping = true
    try {
      for (let step = queue.steps.shift(); step; step = queue.steps.shift()) {
        if (!mountedRef.current) {
          step.settle(false)
          continue
        }
        if ('run' in step) {
          await step.run()
          step.settle(true)
          continue
        }
        const delivered =
          'text' in step
            ? await sendersRef.current.sendText(step.text)
            : await sendersRef.current.sendKeypress(step.key)
        step.settle(delivered)
        // The page no longer matches what was typed after it; drop the rest instead of typing it out of place.
        if (!delivered) {
          queue.steps = queue.steps.filter((next) => {
            if ('run' in next) {
              return true
            }
            next.settle(false)
            return false
          })
        }
      }
    } finally {
      queue.pumping = false
    }
  }, [mountedRef])

  const queuePageInput = useCallback(
    (steps: readonly PageInputStep[]): Promise<boolean> => {
      const queue = inputQueueRef.current
      const settled = steps.map((step) => {
        if ('run' in step) {
          for (const listener of focusListenersRef.current) {
            listener()
          }
        }
        const last = queue.steps.at(-1)
        // Text typed while a send is in flight joins the next send.
        if ('text' in step && last && 'text' in last) {
          last.text += step.text
          const settleLast = last.settle
          return new Promise<boolean>((resolve) => {
            last.settle = (delivered) => {
              settleLast(delivered)
              resolve(delivered)
            }
          })
        }
        return new Promise<boolean>((resolve) => {
          queue.steps.push({ ...step, settle: resolve })
        })
      })
      void pumpPageInput()
      return Promise.all(settled).then((results) => results.every(Boolean))
    },
    [pumpPageInput]
  )

  return useMemo(
    () => ({
      queue: queuePageInput,
      onFocusMove: (listener: () => void) => {
        focusListenersRef.current.add(listener)
        return () => {
          focusListenersRef.current.delete(listener)
        }
      }
    }),
    [queuePageInput]
  )
}
