import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'

export type MobilePromptSuggestionSource = {
  scopeKey?: string
  text?: string | null
  read?: () => Promise<string | null>
}

/** Suggestions only edit drafts; an async terminal read must still belong to the same empty field. */
export function useMobilePromptSuggestion(args: {
  source?: MobilePromptSuggestionSource
  scopeKey: string
  enabled: boolean
  value: string
  onAccept: (text: string) => void
  getEditGeneration: () => number
  getFocusGeneration?: () => number
}) {
  const { source, scopeKey, enabled, value } = args
  const read = source?.read
  const [sample, setSample] = useState<{ scope: string; read: typeof read; text: string | null }>()
  const [dismissed, setDismissed] = useState<{ scope: string; text: string }>()
  const current = useRef(args)
  const generation = useRef(0)
  useLayoutEffect(() => {
    current.current = args
  })
  useLayoutEffect(() => {
    generation.current += 1
    return () => {
      generation.current += 1
    }
  }, [scopeKey, enabled, value, read, source?.text])
  const visible = enabled && value === ''
  useEffect(() => {
    if (!visible || !read) {
      return
    }
    let cancelled = false
    let pending = false
    const poll = async () => {
      if (pending) {
        return
      }
      pending = true
      const text = await read().catch(() => null)
      pending = false
      if (cancelled) {
        return
      }
      setSample({ scope: scopeKey, read, text })
    }
    const timer = setInterval(() => void poll(), 1_000)
    void poll()
    return () => {
      cancelled = true
      clearInterval(timer)
    }
  }, [read, scopeKey, visible])
  const candidate = read
    ? sample?.scope === scopeKey && sample.read === read
      ? sample.text
      : null
    : source?.text
  const text =
    visible &&
    typeof candidate === 'string' &&
    candidate.trim() &&
    !(dismissed?.scope === scopeKey && dismissed.text === candidate)
      ? candidate
      : null
  const accept = useCallback(async () => {
    if (!text || !current.current.enabled || current.current.value !== '') {
      return
    }
    const before = generation.current
    const editGeneration = current.current.getEditGeneration()
    const focusGeneration = current.current.getFocusGeneration?.()
    if (read && (await read().catch(() => null)) !== text) {
      return
    }
    if (
      before !== generation.current ||
      editGeneration !== current.current.getEditGeneration() ||
      focusGeneration !== current.current.getFocusGeneration?.() ||
      current.current.scopeKey !== scopeKey ||
      !current.current.enabled ||
      current.current.value !== ''
    ) {
      return
    }
    setDismissed({ scope: scopeKey, text })
    generation.current += 1
    current.current.onAccept(text)
  }, [read, scopeKey, text])
  const dismiss = () => {
    generation.current += 1
    if (text) {
      setDismissed({ scope: scopeKey, text })
    }
  }
  return { text, accept, dismiss }
}
