'use client'

import { useEffect, useState, useSyncExternalStore } from 'react'
import SearchDialog from './SearchDialog'

const subscribeToPlatform = () => () => {}

function getPlatformSnapshot() {
  return typeof navigator !== 'undefined' && /Mac|iPod|iPhone|iPad/.test(navigator.platform)
}

export default function SearchTrigger() {
  const [open, setOpen] = useState(false)
  const isMac = useSyncExternalStore(subscribeToPlatform, getPlatformSnapshot, () => true)

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault()
        setOpen((o) => !o)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        aria-label="Search docs"
        className="w-full flex items-center gap-2 rounded-md border border-white/[0.16] bg-white/[0.05] hover:bg-white/[0.08] hover:border-white/[0.24] px-2 py-1.5 text-[13px] text-white/80 hover:text-white transition-colors"
      >
        <svg
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          className="w-3.5 h-3.5 shrink-0"
          aria-hidden="true"
        >
          <circle cx="11" cy="11" r="7" />
          <line x1="21" y1="21" x2="16.65" y2="16.65" />
        </svg>
        <span className="flex-1 text-left">Search docs</span>
        <kbd className="inline-flex items-center font-mono text-[10px] text-white/55 border border-white/10 rounded px-1 py-0.5 shrink-0">
          {isMac ? '⌘' : 'Ctrl'}K
        </kbd>
      </button>
      <SearchDialog open={open} onClose={() => setOpen(false)} />
    </>
  )
}
