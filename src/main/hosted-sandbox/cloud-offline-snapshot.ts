// Turns cached RPC answers into what the asleep view shows, and into archive git metadata.
import { z } from 'zod'
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

// CSI/OSC/other escape sequences; the asleep view is plain text. Built from char codes because
// the escape (27) and bell (7) bytes are the point.
const ESC = String.fromCharCode(27)
const BEL = String.fromCharCode(7)
const ANSI = new RegExp(
  `${ESC}\\[[0-?]*[ -/]*[@-~]|${ESC}\\][^${BEL}${ESC}]*(?:${BEL}|${ESC}\\\\)|${ESC}[@-Z\\\\-_]`,
  'g'
)

export function stripAnsi(text: string): string {
  return text.replace(ANSI, '').replace(/\r(?!\n)/g, '')
}

// Cached answers came from the VM: parse leniently, and a malformed piece is skipped, never trusted.
const Text = z.string()
const ChatItemSchema = z.looseObject({
  itemId: Text,
  observedAt: z.number(),
  body: z.looseObject({
    kind: Text,
    role: Text.optional(),
    blocks: z.array(z.looseObject({ type: Text, text: z.unknown().optional() })).optional()
  })
})
const HistoryResultSchema = z.looseObject({
  page: z
    .looseObject({ sessionId: Text.optional(), items: z.array(z.unknown()).optional() })
    .optional()
})
const TerminalListSchema = z.looseObject({
  terminals: z
    .array(
      z.looseObject({
        handle: Text,
        title: Text.nullable().optional(),
        paneTitle: Text.optional()
      })
    )
    .catch([])
    .optional()
})
// `terminal.read` answers `{terminal: RuntimeTerminalRead}`.
const TerminalReadSchema = z.looseObject({
  terminal: z.looseObject({ handle: Text.optional(), tail: z.array(Text).optional() }).optional()
})
const StatusResultSchema = z.looseObject({
  entries: z
    .array(z.looseObject({ path: Text, status: Text, area: Text }))
    .catch([])
    .optional(),
  head: Text.optional().catch(undefined),
  branch: Text.optional().catch(undefined)
})
const HistoryItemsSchema = z.looseObject({
  items: z
    .array(
      z.looseObject({
        id: Text,
        subject: Text,
        author: Text.optional(),
        timestamp: z.number().optional()
      })
    )
    .catch([])
    .optional()
})
const ParamsSchema = z.record(z.string(), z.unknown())

/** A string field of a cached call's params, if it has one. */
export function stringParam(params: unknown, key: string): string | undefined {
  const parsed = ParamsSchema.safeParse(params)
  const value = parsed.success ? parsed.data[key] : undefined
  return typeof value === 'string' ? value : undefined
}

/** Terminal handles from a cached `terminal.list` answer. */
export function terminalHandlesOf(result: unknown): string[] {
  const parsed = TerminalListSchema.safeParse(result)
  return parsed.success ? (parsed.data.terminals ?? []).map((terminal) => terminal.handle) : []
}

function chatOf(entry: OfflineCacheEntry): CloudOfflineChat | null {
  const parsed = HistoryResultSchema.safeParse(entry.result)
  const page = parsed.success ? parsed.data.page : undefined
  const sessionId = page?.sessionId ?? stringParam(entry.params, 'sessionId')
  if (!sessionId || !Array.isArray(page?.items)) {
    return null
  }
  const messages: CloudOfflineChatMessage[] = []
  for (const raw of page.items) {
    const item = ChatItemSchema.safeParse(raw)
    if (!item.success || item.data.body.kind !== 'message' || !item.data.body.blocks) {
      continue
    }
    const text = item.data.body.blocks
      .flatMap((block) =>
        block.type === 'text' && typeof block.text === 'string' ? [block.text] : []
      )
      .join('\n')
      .trim()
    const role = item.data.body.role
    if (!text || (role !== 'user' && role !== 'assistant' && role !== 'system')) {
      continue
    }
    messages.push({ itemId: item.data.itemId, role, text, at: item.data.observedAt })
  }
  return { sessionId, at: entry.at, messages: messages.slice(-MAX_MESSAGES) }
}

/** The newest tail read per session wins; older pages are only used if no tail exists. */
function chatsOf(entries: OfflineCacheEntry[]): CloudOfflineChat[] {
  const bySession = new Map<string, CloudOfflineChat>()
  for (const entry of entries) {
    const direction = stringParam(entry.params, 'direction')
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

async function terminalsOf(
  cache: CloudOfflineCache,
  environmentId: string
): Promise<CloudOfflineTerminal[]> {
  // Every listing contributes titles (a filtered listing can be empty); newest first wins.
  const titles = new Map<string, string | null>()
  for (const list of await cache.entries(environmentId, 'terminal.list')) {
    const parsed = TerminalListSchema.safeParse(list.result)
    for (const terminal of parsed.success ? (parsed.data.terminals ?? []) : []) {
      if (!titles.has(terminal.handle)) {
        titles.set(terminal.handle, terminal.paneTitle ?? terminal.title ?? null)
      }
    }
  }
  const seen = new Set<string>()
  const terminals: CloudOfflineTerminal[] = []
  for (const entry of await cache.entries(environmentId, 'terminal.read')) {
    const parsed = TerminalReadSchema.safeParse(entry.result)
    const result = parsed.success ? parsed.data.terminal : undefined
    const handle = result?.handle ?? stringParam(entry.params, 'terminal')
    if (!handle || seen.has(handle) || !result?.tail) {
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

async function gitOf(
  cache: CloudOfflineCache,
  environmentId: string
): Promise<CloudOfflineGit | null> {
  const status = (await cache.entries(environmentId, 'git.status'))[0]
  const history = (await cache.entries(environmentId, 'git.history'))[0]
  if (!status && !history) {
    return null
  }
  const parsedStatus = StatusResultSchema.safeParse(status?.result ?? {})
  const statusResult = parsedStatus.success ? parsedStatus.data : {}
  const parsedHistory = HistoryItemsSchema.safeParse(history?.result ?? {})
  const items = parsedHistory.success ? (parsedHistory.data.items ?? []) : []
  const entries = statusResult.entries ?? []
  return {
    branch: statusResult.branch?.replace(/^refs\/heads\//, '') ?? null,
    head: statusResult.head ?? null,
    changes: entries
      .slice(0, MAX_CHANGES)
      .map(({ path, status: s, area }) => ({ path, status: s, area })),
    changeCount: entries.length,
    commits: items.slice(0, 20).map((item) => ({
      id: item.id,
      subject: item.subject,
      author: item.author ?? null,
      at: item.timestamp ?? null
    })),
    at: Math.max(status?.at ?? 0, history?.at ?? 0)
  }
}

export async function buildOfflineSnapshot(
  cache: CloudOfflineCache,
  environmentId: string,
  workspaceId: string,
  asleep: boolean
): Promise<CloudOfflineSnapshot> {
  const git = await gitOf(cache, environmentId)
  const terminals = await terminalsOf(cache, environmentId)
  const chats = chatsOf(await cache.entries(environmentId, 'agentSession.history'))
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
export async function archiveCheckoutsFromCache(
  cache: CloudOfflineCache,
  environmentId: string,
  projectRoot: string
): Promise<HostedArchiveCheckout[] | null> {
  const git = await gitOf(cache, environmentId)
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
