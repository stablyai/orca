'use client'

import { useCallback, useEffect, useId, useRef, useState, useSyncExternalStore } from 'react'
import { Search } from 'lucide-react'
import SearchDialog from './SearchDialog'

const subscribeToPlatform = () => () => {}

function getPlatformSnapshot() {
  return typeof navigator !== 'undefined' && navigator.userAgent.includes('Mac')
}

export default function SearchTrigger() {
  const [open, setOpen] = useState(false)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const dialogId = useId()
  const isMac = useSyncExternalStore(subscribeToPlatform, getPlatformSnapshot, () => false)

  const closeSearch = useCallback(() => {
    setOpen(false)
    window.requestAnimationFrame(() => triggerRef.current?.focus())
  }, [])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const modifierPressed = isMac ? e.metaKey : e.ctrlKey
      if (modifierPressed && e.key.toLowerCase() === 'k') {
        e.preventDefault()
        const nextOpen = !open
        setOpen(nextOpen)
        if (!nextOpen) {
          window.requestAnimationFrame(() => triggerRef.current?.focus())
        }
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [isMac, open])

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        onClick={() => setOpen(true)}
        aria-label="Search docs"
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={open ? dialogId : undefined}
        className="flex w-full cursor-pointer items-center gap-2 rounded-md border border-border bg-card px-2 py-1.5 text-[13px] text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
      >
        <Search className="size-3.5 shrink-0" aria-hidden="true" />
        <span className="flex-1 text-left">Search docs</span>
        <kbd className="inline-flex shrink-0 items-center rounded-sm border border-border bg-muted px-1 py-0.5 font-mono text-[10px] text-muted-foreground">
          {isMac ? '⌘K' : 'Ctrl+K'}
        </kbd>
      </button>
      {open && <SearchDialog dialogId={dialogId} onClose={closeSearch} />}
    </>
  )
}
