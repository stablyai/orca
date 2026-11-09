// Turns cached RPC answers into what the asleep view shows, and into archive git metadata.
import type {
  CloudOfflineChat,
  CloudOfflineChatMessage,
  CloudOfflineGit,
  CloudOfflineSnapshot,
  CloudOfflineTerminal
} from '../../shared/hosted-sandbox/cloud-workspace-offline-api'
import type { HostedArchiveCheckout } from '../../shared/hosted-sandbox/hosted-sandbox-wire'
import type { CloudOfflineCache, OfflineCacheEntry } from './cloud-offline-cache'

const MAX_MESSAGES = 200
const MAX_TERMINAL_LINES = 400
const MAX_CHANGES = 300

// CSI/OSC/other escape sequences; the asleep view is plain text.
// oxlint-disable-next-line no-control-regex -- matching terminal escape bytes is the point.
const ANSI =
  /\u001b\[[0-?]*[ -/]*[@-~]|\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)|\u001b[@-Z\\-_]/g

export function stripAnsi(text: string): string {
  return text.replace(ANSI, '').replace(/\r(?!\n)/g, '')
}

type HistoryResult = {
  ok?: boolean
  page?: {
    sessionId?: string
    items?: {
      itemId: string
      observedAt: number
      body: { kind: string; role?: string; blocks?: { type: string; text?: string }[] }
    }[]
  }
}

function chatOf(entry: OfflineCacheEntry): CloudOfflineChat | null {
  const result = entry.result as HistoryResult
  const sessionId =
    result?.page?.sessionId ?? (entry.params as { sessionId?: string } | null)?.sessionId
  if (!sessionId || !Array.isArray(result?.page?.items)) {
    return null
  }
  const messages: CloudOfflineChatMessage[] = []
  for (const item of result.page.items) {
    if (item.body?.kind !== 'message' || !Array.isArray(item.body.blocks)) {
      continue
    }
    const text = item.body.blocks
      .filter((block) => block.type === 'text' && typeof block.text === 'string')
      .map((block) => block.text)
      .join('\n')
      .trim()
    const role = item.body.role
    if (!text || (role !== 'user' && role !== 'assistant' && role !== 'system')) {
      continue
    }
    messages.push({ itemId: item.itemId, role, text, at: item.observedAt })
  }
  return { sessionId, at: entry.at, messages: messages.slice(-MAX_MESSAGES) }
}

/** The newest tail read per session wins; older pages are only used if no tail exists. */
function chatsOf(entries: OfflineCacheEntry[]): CloudOfflineChat[] {
  const bySession = new Map<string, CloudOfflineChat>()
  for (const entry of entries) {
    const direction = (entry.params as { direction?: string } | null)?.direction
    if (direction && direction !== 'tail') {
      continue
    }
    const chat = chatOf(entry)
    if (!chat) {
      continue
    }
    const known = bySession.get(chat.sessionId)
    // Entries come newest first; keep the newest read, but prefer one that has messages.
    if (!known || (known.messages.length === 0 && chat.messages.length > 0)) {
      bySession.set(chat.sessionId, chat)
    }
  }
  return [...bySession.values()].sort((a, b) => b.at - a.at)
}

function terminalsOf(cache: CloudOfflineCache, environmentId: string): CloudOfflineTerminal[] {
  const list = cache.entries(environmentId, 'terminal.list')[0]
  const titles = new Map<string, string | null>()
  for (const terminal of (
    list?.result as {
      terminals?: { handle: string; title: string | null; paneTitle?: string }[]
    } | null
  )?.terminals ?? []) {
    titles.set(terminal.handle, terminal.paneTitle ?? terminal.title ?? null)
  }
  const seen = new Set<string>()
  const terminals: CloudOfflineTerminal[] = []
  for (const entry of cache.entries(environmentId, 'terminal.read')) {
    const result = entry.result as { handle?: string; tail?: string[] } | null
    const handle = result?.handle ?? (entry.params as { terminal?: string } | null)?.terminal
    if (!handle || seen.has(handle) || !Array.isArray(result?.tail)) {
      continue
    }
    seen.add(handle)
    terminals.push({
      handle,
      title: titles.get(handle) ?? null,
      lines: result.tail.slice(-MAX_TERMINAL_LINES).map(stripAnsi),
      at: entry.at
    })
  }
  return terminals
}

type StatusResult = {
  entries?: { path: string; status: string; area: string }[]
  head?: string
  branch?: string
}
type HistoryItems = {
  items?: { id: string; subject: string; author?: string; timestamp?: number }[]
}

function gitOf(cache: CloudOfflineCache, environmentId: string): CloudOfflineGit | null {
  const status = cache.entries(environmentId, 'git.status')[0]
  const history = cache.entries(environmentId, 'git.history')[0]
  if (!status && !history) {
    return null
  }
  const statusResult = (status?.result ?? {}) as StatusResult
  const entries = statusResult.entries ?? []
  return {
    branch: statusResult.branch ?? null,
    head: statusResult.head ?? null,
    changes: entries
      .slice(0, MAX_CHANGES)
      .map(({ path, status: s, area }) => ({ path, status: s, area })),
    changeCount: entries.length,
    commits: (((history?.result ?? {}) as HistoryItems).items ?? []).slice(0, 20).map((item) => ({
      id: item.id,
      subject: item.subject,
      author: item.author ?? null,
      at: item.timestamp ?? null
    })),
    at: Math.max(status?.at ?? 0, history?.at ?? 0)
  }
}

export function buildOfflineSnapshot(
  cache: CloudOfflineCache,
  environmentId: string,
  workspaceId: string,
  asleep: boolean
): CloudOfflineSnapshot {
  const git = gitOf(cache, environmentId)
  const terminals = terminalsOf(cache, environmentId)
  const chats = chatsOf(cache.entries(environmentId, 'agentSession.history'))
  const times = [git?.at ?? 0, ...terminals.map((t) => t.at), ...chats.map((c) => c.at)].filter(
    (t) => t > 0
  )
  return {
    workspaceId,
    asleep,
    capturedAt: times.length > 0 ? Math.max(...times) : null,
    git,
    terminals,
    chats
  }
}

const STATUS_LETTER: Record<string, string> = {
  modified: 'M',
  added: 'A',
  deleted: 'D',
  renamed: 'R',
  untracked: '??',
  copied: 'C'
}

/** Archive metadata from the cache, for archiving a VM that is already asleep. */
export function archiveCheckoutsFromCache(
  cache: CloudOfflineCache,
  environmentId: string,
  projectRoot: string
): HostedArchiveCheckout[] | null {
  const git = gitOf(cache, environmentId)
  if (!git || (!git.branch && !git.head)) {
    return null
  }
  return [
    {
      path: projectRoot,
      branch: git.branch,
      head: git.head && /^[0-9a-f]{7,64}$/.test(git.head) ? git.head : null,
      upstream: null,
      ahead: null,
      behind: null,
      commits: git.commits.slice(0, 20).map((commit) => ({
        sha: commit.id.slice(0, 64),
        author: (commit.author ?? '').slice(0, 120),
        at: commit.at ?? 0,
        subject: commit.subject.slice(0, 300)
      })),
      changes: git.changes.slice(0, 300).map((change) => ({
        status: (STATUS_LETTER[change.status] ?? '?').slice(0, 2),
        path: change.path.slice(0, 1024)
      })),
      diffStat: null,
      fileCount: 0,
      files: []
    }
  ]
}
