import { useCallback, useRef, useState } from 'react'
import { appendTerminalPromptTail, isTerminalPasswordPromptText } from './terminal-password-prompt'

export type TerminalPasswordPromptState = {
  readonly terminalPasswordPromptHandles: ReadonlySet<string>
  readonly observeTerminalOutputForPasswordPrompt: (handle: string, chunk: string) => void
  readonly clearTerminalPasswordPrompt: (handle: string | null | undefined) => void
}

export function useTerminalPasswordPromptState(): TerminalPasswordPromptState {
  const tailsRef = useRef<Map<string, string>>(new Map())
  const [terminalPasswordPromptHandles, setTerminalPasswordPromptHandles] = useState<
    ReadonlySet<string>
  >(() => new Set())

  const observeTerminalOutputForPasswordPrompt = useCallback((handle: string, chunk: string) => {
    if (!handle || !chunk) {
      return
    }
    const nextTail = appendTerminalPromptTail(tailsRef.current.get(handle) ?? '', chunk)
    tailsRef.current.set(handle, nextTail)
    const detected = isTerminalPasswordPromptText(nextTail)
    setTerminalPasswordPromptHandles((prev) => {
      if (prev.has(handle) === detected) {
        return prev
      }
      const next = new Set(prev)
      if (detected) {
        next.add(handle)
      } else {
        next.delete(handle)
      }
      return next
    })
  }, [])

  const clearTerminalPasswordPrompt = useCallback((handle: string | null | undefined) => {
    if (!handle) {
      return
    }
    tailsRef.current.delete(handle)
    setTerminalPasswordPromptHandles((prev) => {
      if (!prev.has(handle)) {
        return prev
      }
      const next = new Set(prev)
      next.delete(handle)
      return next
    })
  }, [])

  return {
    terminalPasswordPromptHandles,
    observeTerminalOutputForPasswordPrompt,
    clearTerminalPasswordPrompt
  }
}
