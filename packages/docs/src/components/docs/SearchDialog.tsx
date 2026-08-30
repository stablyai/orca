'use client'

import { useDocsSearch } from 'fumadocs-core/search/client'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { Fragment, useEffect, useMemo, useRef, useState } from 'react'
import { cn } from '@/lib/utils'

function renderHighlighted(text: string) {
  const nodes: React.ReactNode[] = []
  const regex = /<mark>([\s\S]*?)<\/mark>/g
  let last = 0
  let m: RegExpExecArray | null
  let i = 0
  while ((m = regex.exec(text)) !== null) {
    if (m.index > last) {
      nodes.push(<Fragment key={i++}>{text.slice(last, m.index)}</Fragment>)
    }
    nodes.push(
      <mark key={i++} className="bg-white/[0.15] text-white rounded px-0.5">
        {m[1]}
      </mark>
    )
    last = m.index + m[0].length
  }
  if (last < text.length) {
    nodes.push(<Fragment key={i++}>{text.slice(last)}</Fragment>)
  }
  return nodes
}

type Props = {
  open: boolean
  onClose: () => void
}

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

export default function SearchDialog({ open, onClose }: Props) {
  const { search, setSearch, query } = useDocsSearch({ type: 'fetch' })
  const [activeIndex, setActiveIndex] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLDivElement>(null)
  const router = useRouter()

  const results = useMemo(() => {
    if (!query.data || query.data === 'empty') {
      return []
    }
    return query.data
  }, [query.data])

  useEffect(() => {
    if (open) {
      setSearch('')
      setActiveIndex(0)
      setTimeout(() => inputRef.current?.focus(), 0)
    }
  }, [open, setSearch])

  useEffect(() => {
    setActiveIndex(0)
  }, [results])

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

  useEffect(() => {
    if (!open) {
      return
    }
    const prev = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => {
      document.body.style.overflow = prev
    }
  }, [open])

  useEffect(() => {
    if (!open) {
      return
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        onClose()
      } else if (e.key === 'ArrowDown') {
        e.preventDefault()
        setActiveIndex((i) => Math.min(i + 1, Math.max(results.length - 1, 0)))
      } else if (e.key === 'ArrowUp') {
        e.preventDefault()
        setActiveIndex((i) => Math.max(i - 1, 0))
      } else if (e.key === 'Enter') {
        const r = results[activeIndex]
        if (r) {
          e.preventDefault()
          router.push(r.url)
          onClose()
        }
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, results, activeIndex, router, onClose])

  useEffect(() => {
    const el = listRef.current?.querySelector<HTMLElement>(`[data-idx="${activeIndex}"]`)
    el?.scrollIntoView({ block: 'nearest' })
  }, [activeIndex])

  if (!open) {
    return null
  }

  return (
    <div className="fixed inset-0 z-[100] flex items-start justify-center pt-[12vh] px-4">
      <button
        type="button"
        aria-label="Close search"
        onClick={onClose}
        className="absolute inset-0 bg-black/40"
      />
      <div className="relative w-full max-w-xl rounded-xl border border-white/[0.1] bg-[#0a0a0a] shadow-2xl overflow-hidden">
        <div className="flex items-center gap-3 px-4 border-b border-white/[0.08]">
          <svg
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            className="w-4 h-4 text-white/55 shrink-0"
            aria-hidden="true"
          >
            <circle cx="11" cy="11" r="7" />
            <line x1="21" y1="21" x2="16.65" y2="16.65" />
          </svg>
          <input
            ref={inputRef}
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search docs…"
            className="flex-1 bg-transparent py-3.5 text-[14px] text-white placeholder:text-white/50 outline-none"
          />
          <kbd className="hidden sm:inline-flex items-center font-mono text-[10px] text-white/55 border border-white/10 rounded px-1.5 py-0.5">
            ESC
          </kbd>
        </div>

        <div ref={listRef} className="max-h-[60vh] overflow-y-auto [scrollbar-width:thin]">
          {query.isLoading && <div className="px-4 py-6 text-sm text-white/55">Searching…</div>}
          {showEmpty && (
            <div className="px-4 py-6">
              <div className="text-sm text-white/60">No results for &ldquo;{search}&rdquo;.</div>
              <div className="text-sm text-white/50 mt-5 mb-4">
                Can&rsquo;t find what you need? Check the source or ask us directly:
              </div>
              <div className="flex flex-col sm:flex-row gap-2">
                <a
                  href="https://github.com/stablyai/orca"
                  target="_blank"
                  rel="noopener noreferrer"
                  onClick={onClose}
                  className="flex-1 flex items-center gap-2.5 rounded-md border border-white/[0.1] bg-white/[0.03] hover:bg-white/[0.06] px-3 py-2.5 text-sm text-white/80 hover:text-white transition-colors"
                >
                  <svg
                    viewBox="0 0 24 24"
                    fill="currentColor"
                    className="w-4 h-4 shrink-0"
                    aria-hidden="true"
                  >
                    <path d="M12 .5C5.73.5.5 5.73.5 12a11.5 11.5 0 0 0 7.86 10.92c.57.1.78-.25.78-.55v-2.1c-3.2.7-3.88-1.37-3.88-1.37-.52-1.32-1.27-1.67-1.27-1.67-1.04-.71.08-.7.08-.7 1.15.08 1.76 1.18 1.76 1.18 1.03 1.76 2.7 1.25 3.36.96.1-.74.4-1.25.73-1.54-2.56-.29-5.25-1.28-5.25-5.7 0-1.26.45-2.29 1.18-3.1-.12-.29-.51-1.47.11-3.06 0 0 .97-.31 3.18 1.18a11 11 0 0 1 5.78 0c2.2-1.49 3.17-1.18 3.17-1.18.63 1.59.23 2.77.12 3.06.74.81 1.18 1.84 1.18 3.1 0 4.43-2.7 5.4-5.27 5.69.41.35.78 1.05.78 2.12v3.14c0 .3.21.66.79.55A11.5 11.5 0 0 0 23.5 12C23.5 5.73 18.27.5 12 .5z" />
                  </svg>
                  <div className="min-w-0 text-left">
                    <div className="font-medium">View on GitHub</div>
                    <div className="text-[11px] text-white/55 truncate">Browse the source code</div>
                  </div>
                </a>
                <a
                  href="https://discord.gg/fzjDKHxv8Q"
                  target="_blank"
                  rel="noopener noreferrer"
                  onClick={onClose}
                  className="flex-1 flex items-center gap-2.5 rounded-md border border-white/[0.1] bg-white/[0.03] hover:bg-white/[0.06] px-3 py-2.5 text-sm text-white/80 hover:text-white transition-colors"
                >
                  <svg
                    viewBox="0 0 24 24"
                    fill="currentColor"
                    className="w-4 h-4 shrink-0"
                    aria-hidden="true"
                  >
                    <path d="M20.317 4.37a19.79 19.79 0 0 0-4.885-1.515.074.074 0 0 0-.079.037c-.21.375-.444.864-.608 1.25a18.27 18.27 0 0 0-5.487 0 12.64 12.64 0 0 0-.617-1.25.077.077 0 0 0-.079-.037A19.736 19.736 0 0 0 3.677 4.37a.07.07 0 0 0-.032.027C.533 9.046-.32 13.58.099 18.057a.082.082 0 0 0 .031.057 19.9 19.9 0 0 0 5.993 3.03.078.078 0 0 0 .084-.028c.462-.63.874-1.295 1.226-1.994a.076.076 0 0 0-.041-.106 13.107 13.107 0 0 1-1.872-.892.077.077 0 0 1-.008-.128 10.2 10.2 0 0 0 .372-.292.074.074 0 0 1 .077-.01c3.928 1.793 8.18 1.793 12.062 0a.074.074 0 0 1 .078.01c.12.098.246.198.373.292a.077.077 0 0 1-.006.127 12.3 12.3 0 0 1-1.873.892.077.077 0 0 0-.041.107c.36.698.772 1.362 1.225 1.993a.076.076 0 0 0 .084.028 19.84 19.84 0 0 0 6.002-3.03.077.077 0 0 0 .032-.054c.5-5.177-.838-9.674-3.549-13.66a.061.061 0 0 0-.031-.029zM8.02 15.33c-1.182 0-2.157-1.085-2.157-2.419 0-1.333.956-2.419 2.157-2.419 1.21 0 2.176 1.096 2.157 2.42 0 1.333-.956 2.418-2.157 2.418zm7.975 0c-1.183 0-2.157-1.085-2.157-2.419 0-1.333.955-2.419 2.157-2.419 1.21 0 2.176 1.096 2.157 2.42 0 1.333-.946 2.418-2.157 2.418z" />
                  </svg>
                  <div className="min-w-0 text-left">
                    <div className="font-medium">Join Discord</div>
                    <div className="text-[11px] text-white/55 truncate">Ask the community</div>
                  </div>
                </a>
              </div>
            </div>
          )}
          {!search && !query.isLoading && (
            <div className="py-3 px-3">
              <div className="px-2 pb-2 text-[12px] text-white/50">Popular searches</div>
              <ul className="space-y-0.5">
                {POPULAR_SEARCHES.map((item) => (
                  <li key={item.url}>
                    <Link
                      href={item.url}
                      onClick={onClose}
                      className="group block rounded-md px-3 py-2.5 hover:bg-white/[0.05] transition-colors"
                    >
                      <div className="text-[11px] text-white/45 mb-1 truncate">
                        {item.breadcrumb.map((crumb, i) => (
                          <Fragment key={i}>
                            {i > 0 && <span className="mx-1.5 text-white/55">›</span>}
                            {crumb}
                          </Fragment>
                        ))}
                      </div>
                      <div className="flex items-baseline gap-2">
                        <span className="text-white/55 font-mono text-[13px]">#</span>
                        <span className="text-[14px] font-semibold text-white truncate">
                          {item.title}
                        </span>
                      </div>
                      <div className="text-[12.5px] text-white/55 mt-0.5 leading-snug line-clamp-2">
                        {item.description}
                      </div>
                    </Link>
                  </li>
                ))}
              </ul>
            </div>
          )}
          {results.length > 0 && (
            <div className="py-3 px-3">
              {(() => {
                const groups: { page: (typeof results)[number] | null; items: typeof results }[] =
                  []
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
                          className={cn(
                            'block rounded px-2 py-1 mb-1 font-mono text-[11px] uppercase tracking-widest transition-colors',
                            pageIdx === activeIndex
                              ? 'bg-white/[0.08] text-white'
                              : 'text-white/90 hover:bg-white/[0.04]'
                          )}
                        >
                          {g.page.content ? renderHighlighted(g.page.content) : g.page.url}
                        </Link>
                      )}
                      <ul className="space-y-0.5">
                        {g.items.map((r) => {
                          const i = ++idx
                          const active = i === activeIndex
                          return (
                            <li key={r.id}>
                              <Link
                                href={r.url}
                                onClick={onClose}
                                onMouseEnter={() => setActiveIndex(i)}
                                data-idx={i}
                                className={cn(
                                  'block rounded px-2 py-1 leading-snug text-[13px] transition-colors',
                                  active
                                    ? 'bg-white/[0.08] text-white'
                                    : 'text-gray-300 hover:text-white hover:bg-white/[0.04]'
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
