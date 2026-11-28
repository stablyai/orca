import { useEffect, useMemo, useState } from 'react'
import { hostReadClient, readViewBase } from '../../query/host-read-client'
import type { RpcClient } from '../../transport/rpc/rpc-client-contract'
import {
  fileContentSearchRead,
  type FileContentSearchAnswer
} from './file-content-search-operations'

const SEARCH_DEBOUNCE_MS = 300
// One letter matches nearly every line; the name search still answers it.
const MIN_QUERY_LENGTH = 2
// Matches, not files: enough to scan on a phone, a tenth of desktop's 2000.
const SEARCH_MAX_RESULTS = 200
// The host gives a search 15 s; this leaves room for the reply.
const SEARCH_TIMEOUT_MS = 20_000

export type FileContentSearchResult = {
  query: string
  files: NonNullable<FileContentSearchAnswer['files']>
  truncated: boolean
}

type Search = { run: () => Promise<void> }
type Lane = { running: boolean; next: Search | null }

// Why per connection, not per hook: the host stops a search only when the socket closes, so a
// reopened explorer must queue behind one still running rather than start a second.
const lanes = new WeakMap<object, Lane>()

function drain(lane: Lane): void {
  if (lane.running || !lane.next) {
    return
  }
  const { run } = lane.next
  lane.next = null
  lane.running = true
  void run().finally(() => {
    lane.running = false
    drain(lane)
  })
}

function admit(client: RpcClient, search: Search): void {
  const base = readViewBase(client)
  let lane = lanes.get(base)
  if (!lane) {
    lane = { running: false, next: null }
    lanes.set(base, lane)
  }
  // The newest wanted search replaces any waiting one; superseded text never goes.
  lane.next = search
  drain(lane)
}

function withdraw(client: RpcClient, search: Search): void {
  const lane = lanes.get(readViewBase(client))
  if (lane?.next === search) {
    lane.next = null
  }
}

/**
 * Searches inside the workspace's files for what the explorer's search field holds.
 * One search per connection runs at a time; only the newest text waiting goes next.
 */
export function useMobileFileContentSearch(args: {
  client: RpcClient | null
  worktreeId: string
  query: string
  enabled: boolean
  connected: boolean
}): { result: FileContentSearchResult | null; pending: boolean } {
  const { client, worktreeId, enabled, connected } = args
  const query = args.query.trim()
  const searchable = enabled && connected && client !== null && query.length >= MIN_QUERY_LENGTH
  // A new workspace or connection asks again; an answer from an old one is never shown.
  const scope = `${worktreeId}\u0000${client?.getGeneration?.() ?? 0}`
  const [result, setResult] = useState<(FileContentSearchResult & { scope: string }) | null>(null)

  useEffect(() => {
    if (!searchable || !client) {
      return
    }
    let live = true
    const search: Search = {
      run: async () => {
        if (!live) {
          return
        }
        try {
          // Rejects while disconnected instead of replaying after the reconnect.
          const reply = await fileContentSearchRead.request(
            hostReadClient(client),
            { worktree: `id:${worktreeId}`, query, maxResults: SEARCH_MAX_RESULTS },
            { timeoutMs: SEARCH_TIMEOUT_MS }
          )
          const answer = fileContentSearchRead.interpret(reply)
          if (live) {
            setResult({
              scope,
              query,
              files: answer.accepted ? (answer.value.files ?? []) : [],
              truncated: answer.accepted && answer.value.truncated === true
            })
          }
        } catch {
          // A dropped connection is no answer, since reconnecting asks again; anything else shows no hits.
          if (live && client.getState() === 'connected') {
            setResult({ scope, query, files: [], truncated: false })
          }
        }
      }
    }
    const timer = setTimeout(() => admit(client, search), SEARCH_DEBOUNCE_MS)
    return () => {
      live = false
      clearTimeout(timer)
      withdraw(client, search)
    }
  }, [client, query, scope, searchable, worktreeId])

  // While the next answer is out, the last one stays only if the new text narrows it, as name results do,
  // and only its lines that still hold the text (the host's default search ignores case).
  const held =
    searchable && result && result.scope === scope && query.startsWith(result.query) ? result : null
  const shown = useMemo(() => (held ? narrowedResult(held, query) : null), [held, query])
  return { result: shown, pending: searchable && held?.query !== query }
}

function narrowedResult(result: FileContentSearchResult, query: string): FileContentSearchResult {
  if (result.query === query) {
    return result
  }
  const needle = query.toLowerCase()
  const files = result.files.flatMap((file) => {
    const matches = file.matches.filter((match) => match.lineContent.toLowerCase().includes(needle))
    return matches.length > 0 ? [{ ...file, matches }] : []
  })
  return { ...result, files }
}
