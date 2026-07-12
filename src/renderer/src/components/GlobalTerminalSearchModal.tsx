import React, { useState, useEffect, useCallback } from 'react'
import { Command } from 'cmdk'
import { Search, TerminalSquare, X } from 'lucide-react'
import { searchAllTerminals, type TerminalSearchMatch } from './terminal-pane/terminal-registry'
import { useAppStore } from '../store'
import { getAppCommandPaletteContainer } from '@/lib/app-command-palette-container'
import { createPortal } from 'react-dom'

type Props = {
  isOpen: boolean
  onClose: () => void
}

export function GlobalTerminalSearchModal({ isOpen, onClose }: Props) {
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<TerminalSearchMatch[]>([])

  useEffect(() => {
    if (!isOpen) {
      setQuery('')
      setResults([])
      return
    }

    // Simple debounce could go here, but for now we search directly
    const timer = setTimeout(() => {
      if (query.trim()) {
        setResults(searchAllTerminals(query, false))
      } else {
        setResults([])
      }
    }, 150)

    return () => clearTimeout(timer)
  }, [query, isOpen])

  // Handle escape to close
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && isOpen) {
        onClose()
      }
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [isOpen, onClose])

  const handleSelect = useCallback(
    (match: TerminalSearchMatch) => {
      // 1. Focus the workspace
      useAppStore.getState().setActiveWorktreeId(match.worktreeId)
      // 2. Focus the tab
      useAppStore.getState().setActiveTabId(match.tabId)
      // 3. Focus the pane
      import('./terminal-pane/terminal-registry').then(({ getTerminalPaneRegistration }) => {
        const reg = getTerminalPaneRegistration(match.paneId)
        if (reg) {
          // Wait a tick for the tab to render and the PaneManager to be available
          setTimeout(() => reg.focus(), 100)
        }
      })
      onClose()
    },
    [onClose]
  )

  if (!isOpen) {
    return null
  }

  const container = getAppCommandPaletteContainer()
  if (!container) {
    return null
  }

  return createPortal(
    <div className="fixed inset-0 z-50 flex items-start justify-center pt-24 bg-background/50 backdrop-blur-sm">
      <Command
        className="w-full max-w-2xl bg-popover text-popover-foreground rounded-xl shadow-2xl border flex flex-col overflow-hidden"
        loop
      >
        <div className="flex items-center border-b px-3" cmdk-input-wrapper="">
          <Search className="mr-2 h-4 w-4 shrink-0 opacity-50" />
          <Command.Input
            autoFocus
            value={query}
            onValueChange={setQuery}
            placeholder="Search across all terminals..."
            className="flex h-12 w-full rounded-md bg-transparent py-3 text-sm outline-none placeholder:text-muted-foreground disabled:cursor-not-allowed disabled:opacity-50"
          />
          <button onClick={onClose} className="p-1 hover:bg-muted rounded">
            <X className="h-4 w-4 opacity-50" />
          </button>
        </div>
        <Command.List className="max-h-[60vh] overflow-y-auto p-2">
          <Command.Empty className="py-6 text-center text-sm text-muted-foreground">
            {query ? 'No matches found.' : 'Type to search all active terminal buffers.'}
          </Command.Empty>
          {results.map((match, i) => (
            <Command.Item
              key={`${match.paneId}-${match.lineNumber}-${i}`}
              onSelect={() => handleSelect(match)}
              className="flex items-center gap-2 px-2 py-2 text-sm rounded-md cursor-pointer aria-selected:bg-accent aria-selected:text-accent-foreground"
            >
              <TerminalSquare className="h-4 w-4 opacity-50 shrink-0" />
              <div className="flex flex-col min-w-0 overflow-hidden">
                <span className="font-medium text-xs opacity-70 truncate">
                  {match.title} (Line {match.lineNumber})
                </span>
                <span className="truncate">
                  {match.lineText.substring(0, match.matchStartIndex)}
                  <mark className="bg-yellow-500/50 text-foreground rounded-sm">
                    {match.lineText.substring(match.matchStartIndex, match.matchEndIndex)}
                  </mark>
                  {match.lineText.substring(match.matchEndIndex)}
                </span>
              </div>
            </Command.Item>
          ))}
        </Command.List>
      </Command>
    </div>,
    container
  )
}
