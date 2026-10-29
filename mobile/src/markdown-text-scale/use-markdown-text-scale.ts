import { useCallback, useEffect, useSyncExternalStore } from 'react'
import { subscribeMirroredKey } from '../storage/mirrored-storage-keys'
import {
  loadMarkdownTextScale,
  MARKDOWN_TEXT_SCALE_KEY,
  saveMarkdownTextScale
} from '../storage/preferences'
import { MARKDOWN_TEXT_SCALES, snapMarkdownTextScale } from './markdown-text-scales'

// One module store so every Markdown surface (file preview, session tab) shows the same size.
let current = 1
let loadStarted = false
// Set by a pick or a mirrored value; either is newer than what the pending load read.
let newerThanLoad = false
const listeners = new Set<() => void>()

function setCurrent(scale: number) {
  newerThanLoad = true
  if (scale === current) {
    return
  }
  current = scale
  listeners.forEach((listener) => listener())
}

function ensureLoaded() {
  if (loadStarted) {
    return
  }
  loadStarted = true
  subscribeMirroredKey(MARKDOWN_TEXT_SCALE_KEY, (value) => {
    const parsed = Number(value)
    if (!MARKDOWN_TEXT_SCALES.some((scale) => scale === parsed)) {
      return
    }
    newerThanLoad = true
    if (parsed !== current) {
      current = parsed
      listeners.forEach((listener) => listener())
    }
  })
  void loadMarkdownTextScale().then((saved) => {
    if (!newerThanLoad && saved !== current) {
      current = saved
      listeners.forEach((listener) => listener())
    }
  })
}

function subscribe(listener: () => void) {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

function commitTextScale(scale: number) {
  const snapped = snapMarkdownTextScale(scale)
  setCurrent(snapped)
  saveMarkdownTextScale(snapped).catch(() => {
    // Keep the optimistic scale when persistence is unavailable.
  })
}

export function useMarkdownTextScale(): {
  textScale: number
  setLiveScale(scale: number): void
  commitTextScale(scale: number): void
} {
  const textScale = useSyncExternalStore(
    subscribe,
    () => current,
    () => current
  )
  useEffect(ensureLoaded, [])
  const setLiveScale = useCallback((scale: number) => setCurrent(scale), [])
  return { textScale, setLiveScale, commitTextScale }
}
