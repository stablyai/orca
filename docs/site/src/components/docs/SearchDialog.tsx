'use client'

import { useDocsSearch } from 'fumadocs-core/search/client'
import { GitBranch, MessageCircle, Search, X } from 'lucide-react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { Fragment, useEffect, useMemo, useRef, useState } from 'react'
import { cn } from '@/lib/class-names'
import { stripSearchExcerptMarkdown } from './search-excerpt.mjs'

function renderHighlighted(text: string) {
  const excerpt = stripSearchExcerptMarkdown(text)
  const nodes: React.ReactNode[] = []
  const regex = /<mark>([\s\S]*?)<\/mark>/g
  let last = 0
  let m: RegExpExecArray | null
  let i = 0
  while ((m = regex.exec(excerpt)) !== null) {
    if (m.index > last) {
      nodes.push(<Fragment key={i++}>{excerpt.slice(last, m.index)}</Fragment>)
    }
    nodes.push(
      <mark key={i++} className="rounded-sm bg-accent px-0.5 text-accent-foreground">
        {m[1]}
      </mark>
    )
    last = m.index + m[0].length
  }
  if (last < excerpt.length) {
    nodes.push(<Fragment key={i++}>{excerpt.slice(last)}</Fragment>)
  }
  return nodes
}

type Props = {
  dialogId?: string
  onClose: () => void
}

type SearchResult = {
  id: string
  url: string
  type: 'page' | 'heading' | 'text'
  content: string
}

const DIALOG_FOCUSABLE_SELECTOR =
  'a[href], button:not([disabled]):not([tabindex="-1"]), input:not([disabled]), [tabindex]:not([tabindex="-1"])'

const POPULAR_SEARCHES: {
  breadcrumb: string[]
  title: string
  description: string
  url: string
}[] = [
  {
    breadcrumb: ['Documentation', 'The Orca Model', 'Worktrees'],
    title: 'Worktrees',
    description:
      "Every feature or bug gets its own on-disk copy of the repo via git worktree — parallel agents never step on each other's files.",
    url: '/docs/model/worktrees'
  },
  {
    breadcrumb: ['Working with Agents', 'Hot-swap Codex accounts'],
    title: 'Hot-swap Codex accounts',
    description:
      'Switch between multiple Codex or Claude accounts in one click to maximize tokens — no re-login, no config editing.',
    url: '/docs/agents/codex-hot-swap'
  },
  {
    breadcrumb: ['Browser & Design Mode', 'Design Mode'],
    title: 'Design Mode',
    description:
      'Click any UI element in the Orca browser — its HTML, computed styles, and screenshot drop straight into the agent chat.',
    url: '/docs/browser/design-mode'
  },
  {
    breadcrumb: ['Reviewing & Shipping Code', 'Annotate AI Diff'],
    title: 'Annotate AI Diff',
    description:
      'Leave inline comments on any line of an agent-generated hunk, then batch them back to the agent for revision.',
    url: '/docs/review/annotate-ai-diff'
  },
  {
    breadcrumb: ['Recipes', 'Race three agents on the same task'],
    title: 'Race three agents on the same task',
    description:
      'Same prompt, three worktrees, three different agents — pick the winning diff and throw the rest away.',
    url: '/docs/recipes/parallel-agents'
  },
  {
    breadcrumb: ['Working with Agents', 'Agent hooks & memory'],
    title: 'Agent hooks & memory',
    description:
      "Orca reads each repo's .claude/ and .codex/ config, runs your hooks on worktree create, and surfaces CLAUDE.md / AGENTS.md inline.",
    url: '/docs/agents/hooks-memory'
  },
  {
    breadcrumb: ['Recipes', 'Work on a remote machine over SSH'],
    title: 'Work on a remote machine over SSH',
    description:
      'Point Orca at any SSH target — a dev box, a GPU host, a cloud sandbox — and open remote repos or just folders. Same editor, same diff view, different compute.',
    url: '/docs/recipes/remote-worktrees'
  }
]

export default function SearchDialog({ dialogId = 'docs-search-dialog', onClose }: Props) {
  const { search, setSearch, query } = useDocsSearch({
    type: 'fetch',
    api: '/docs/api/search'
  })
  const [activeIndex, setActiveIndex] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLDivElement>(null)
  const dialogRef = useRef<HTMLDivElement>(null)
  const router = useRouter()

  const results = useMemo<SearchResult[]>(() => {
    if (!query.data || query.data === 'empty') {
      return []
    }
    return query.data
  }, [query.data])

  const selectedIndex = Math.min(activeIndex, Math.max(results.length - 1, 0))

  useEffect(() => {
    const focusTimer = window.setTimeout(() => inputRef.current?.focus(), 0)
    return () => window.clearTimeout(focusTimer)
  }, [])

  const [debouncedQuery, setDebouncedQuery] = useState('')
  useEffect(() => {
    const t = setTimeout(() => setDebouncedQuery(search), 350)
    return () => clearTimeout(t)
  }, [search])

  const showEmpty =
    search.trim().length > 0 &&
    debouncedQuery === search &&
    !query.isLoading &&
    results.length === 0

  function handleSearchChange(value: string) {
    setSearch(value)
    setActiveIndex(0)
  }

  useEffect(() => {
    const prev = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => {
      document.body.style.overflow = prev
    }
  }, [])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Tab') {
        const controls = dialogRef.current?.querySelectorAll<HTMLElement>(DIALOG_FOCUSABLE_SELECTOR)
        if (!controls?.length) {
          return
        }
        const first = controls[0]
        const last = controls.item(controls.length - 1)
        if (!first || !last) {
          return
        }
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault()
          last.focus()
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault()
          first.focus()
        }
      } else if (e.key === 'Escape') {
        e.preventDefault()
        onClose()
      } else if (e.key === 'ArrowDown' && document.activeElement === inputRef.current) {
        e.preventDefault()
        setActiveIndex(Math.min(selectedIndex + 1, Math.max(results.length - 1, 0)))
      } else if (e.key === 'ArrowUp' && document.activeElement === inputRef.current) {
        e.preventDefault()
        setActiveIndex(Math.max(selectedIndex - 1, 0))
      } else if (e.key === 'Enter' && document.activeElement === inputRef.current) {
        const r = results[selectedIndex]
        if (r) {
          e.preventDefault()
          router.push(r.url)
          onClose()
        }
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [results, selectedIndex, router, onClose])

  useEffect(() => {
    const el = listRef.current?.querySelector<HTMLElement>(`[data-idx="${selectedIndex}"]`)
    el?.scrollIntoView({ block: 'nearest' })
  }, [selectedIndex])

  return (
    <div className="fixed inset-0 z-[100] flex items-start justify-center px-4 pt-[12vh]">
      <button
        type="button"
        aria-label="Close search"
        tabIndex={-1}
        onClick={onClose}
        className="absolute inset-0 bg-background/80 backdrop-blur-sm"
      />
      <div
        id={dialogId}
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-label="Search documentation"
        className="relative w-full max-w-xl overflow-hidden rounded-xl border border-border bg-popover text-popover-foreground shadow-floating"
      >
        <div className="flex items-center gap-3 border-b border-border px-4">
          <Search className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
          <input
            ref={inputRef}
            value={search}
            onChange={(e) => handleSearchChange(e.target.value)}
            placeholder="Search docs…"
            aria-label="Search documentation"
            className="flex-1 bg-transparent py-3.5 text-sm text-foreground placeholder:text-muted-foreground focus-visible:outline-none"
          />
          <button
            type="button"
            onClick={onClose}
            aria-label="Close search"
            className="inline-flex size-8 shrink-0 cursor-pointer items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
          >
            <X className="size-4" aria-hidden="true" />
          </button>
        </div>

        <div ref={listRef} className="scrollbar-sleek max-h-[60vh] overflow-y-auto">
          {query.isLoading && (
            <div className="px-4 py-6 text-sm text-muted-foreground">Searching…</div>
          )}
          {showEmpty && (
            <div className="px-4 py-6">
              <div className="text-sm text-muted-foreground">
                No results for &ldquo;{search}&rdquo;.
              </div>
              <div className="mb-4 mt-5 text-sm text-muted-foreground">
                Can&rsquo;t find what you need? Check the source or ask us directly:
              </div>
              <div className="flex flex-col gap-2 sm:flex-row">
                <a
                  href="https://github.com/stablyai/orca"
                  target="_blank"
                  rel="noopener noreferrer"
                  onClick={onClose}
                  className="flex-1 rounded-md border border-border bg-card px-3 py-2.5 text-sm text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
                >
                  <div className="flex items-center gap-2.5 text-left">
                    <GitBranch className="size-4 shrink-0" aria-hidden="true" />
                    <div className="min-w-0">
                      <div className="font-medium">View on GitHub</div>
                      <div className="truncate text-[11px] text-muted-foreground">
                        Browse the source code
                      </div>
                    </div>
                  </div>
                </a>
                <a
                  href="https://discord.gg/fzjDKHxv8Q"
                  target="_blank"
                  rel="noopener noreferrer"
                  onClick={onClose}
                  className="flex-1 rounded-md border border-border bg-card px-3 py-2.5 text-sm text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
                >
                  <div className="flex items-center gap-2.5 text-left">
                    <MessageCircle className="size-4 shrink-0" aria-hidden="true" />
                    <div className="min-w-0">
                      <div className="font-medium">Join Discord</div>
                      <div className="truncate text-[11px] text-muted-foreground">
                        Ask the community
                      </div>
                    </div>
                  </div>
                </a>
              </div>
            </div>
          )}
          {!search && !query.isLoading && (
            <div className="px-3 py-3">
              <div className="px-2 pb-2 text-xs text-muted-foreground">Popular searches</div>
              <ul className="space-y-0.5">
                {POPULAR_SEARCHES.map((item) => (
                  <li key={item.url}>
                    <Link
                      href={item.url}
                      onClick={onClose}
                      className="group block rounded-md px-3 py-2.5 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
                    >
                      <div className="mb-1 truncate text-[11px] text-muted-foreground">
                        {item.breadcrumb.map((crumb, i) => (
                          <Fragment key={i}>
                            {i > 0 && <span className="mx-1.5 text-muted-foreground">›</span>}
                            {crumb}
                          </Fragment>
                        ))}
                      </div>
                      <div className="flex items-baseline gap-2">
                        <span className="font-mono text-[13px] text-muted-foreground">#</span>
                        <span className="truncate text-sm font-semibold text-foreground">
                          {item.title}
                        </span>
                      </div>
                      <div className="mt-0.5 line-clamp-2 text-xs leading-snug text-muted-foreground">
                        {item.description}
                      </div>
                    </Link>
                  </li>
                ))}
              </ul>
            </div>
          )}
          {results.length > 0 && (
            <div className="px-3 py-3">
              {(() => {
                const groups: { page: SearchResult | null; items: SearchResult[] }[] = []
                for (const r of results) {
                  if (r.type === 'page') {
                    groups.push({ page: r, items: [] })
                  } else {
                    if (groups.length === 0) {
                      groups.push({ page: null, items: [] })
                    }
                    groups.at(-1)!.items.push(r)
                  }
                }
                let idx = -1
                return groups.map((g, gi) => {
                  const pageIdx = g.page ? ++idx : -1
                  return (
                    <div key={gi} className="mb-4 last:mb-0">
                      {g.page && (
                        <Link
                          href={g.page.url}
                          onClick={onClose}
                          onMouseEnter={() => setActiveIndex(pageIdx)}
                          data-idx={pageIdx}
                          data-selected={pageIdx === selectedIndex}
                          className={cn(
                            'mb-1 block rounded-md px-2 py-1 font-mono text-[11px] uppercase tracking-widest transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50',
                            pageIdx === selectedIndex
                              ? 'bg-accent text-accent-foreground'
                              : 'text-muted-foreground hover:bg-accent hover:text-foreground'
                          )}
                        >
                          {g.page.content ? renderHighlighted(g.page.content) : g.page.url}
                        </Link>
                      )}
                      <ul className="space-y-0.5">
                        {g.items.map((r) => {
                          const i = ++idx
                          const active = i === selectedIndex
                          return (
                            <li key={r.id}>
                              <Link
                                href={r.url}
                                onClick={onClose}
                                onMouseEnter={() => setActiveIndex(i)}
                                data-idx={i}
                                data-selected={active}
                                className={cn(
                                  'block rounded-md px-2 py-1 text-[13px] leading-snug transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50',
                                  active
                                    ? 'bg-accent text-accent-foreground'
                                    : 'text-muted-foreground hover:bg-accent hover:text-foreground'
                                )}
                              >
                                <div className="truncate">
                                  {r.content ? renderHighlighted(r.content) : r.url}
                                </div>
                              </Link>
                            </li>
                          )
                        })}
                      </ul>
                    </div>
                  )
                })
              })()}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
