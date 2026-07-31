// Why: Claude's PermissionRequest carries no `tool_use_id`, so a pane must remember the ids announced in
// `PreToolUse` to prove the approved call resumed; the prompt's own announcement is not always adjacent.

export type ClaudeAnnouncedToolUse = {
  toolUseId: string
  toolName: string
  toolInput?: string
  toolAgentId?: string
  toolAgentType?: string
  recordedAt: number
}

export type ClaudeAnnouncedToolUseStore = Map<string, ClaudeAnnouncedToolUse[]>

// Why: bounds a turn whose Stop hook never arrives; a batch announces far fewer calls than this.
export const CLAUDE_ANNOUNCED_TOOL_USE_MAX_PER_PANE = 64

// Why: backstop for the same case; must outlast a human staring at a prompt, since the turn stays open.
export const CLAUDE_ANNOUNCED_TOOL_USE_TTL_MS = 60 * 60_000

type ClaudeToolUseIdentity = {
  toolUseId?: string
  toolName?: string
  toolInput?: string
  toolAgentId?: string
  toolAgentType?: string
}

function isFresh(entry: ClaudeAnnouncedToolUse, now: number): boolean {
  return now - entry.recordedAt <= CLAUDE_ANNOUNCED_TOOL_USE_TTL_MS
}

function matchesIdentity(entry: ClaudeAnnouncedToolUse, request: ClaudeToolUseIdentity): boolean {
  return (
    entry.toolName === request.toolName &&
    entry.toolInput === request.toolInput &&
    entry.toolAgentId === request.toolAgentId &&
    entry.toolAgentType === request.toolAgentType
  )
}

/** Record the id Claude announced for a tool call. Safe to call for every live claude `PreToolUse`. */
export function rememberClaudeAnnouncedToolUse(
  store: ClaudeAnnouncedToolUseStore,
  paneKey: string,
  toolUse: ClaudeToolUseIdentity,
  now = Date.now()
): void {
  const toolUseId = toolUse.toolUseId?.trim()
  const toolName = toolUse.toolName?.trim()
  if (!toolUseId || !toolName) {
    return
  }
  const entry: ClaudeAnnouncedToolUse = {
    toolUseId,
    toolName,
    ...(toolUse.toolInput !== undefined ? { toolInput: toolUse.toolInput } : {}),
    ...(toolUse.toolAgentId !== undefined ? { toolAgentId: toolUse.toolAgentId } : {}),
    ...(toolUse.toolAgentType !== undefined ? { toolAgentType: toolUse.toolAgentType } : {}),
    recordedAt: now
  }
  // Why: a retried announcement refreshes its entry rather than queueing a second copy of the same call.
  const kept = (store.get(paneKey) ?? []).filter(
    (candidate) => candidate.toolUseId !== toolUseId && isFresh(candidate, now)
  )
  kept.push(entry)
  store.set(paneKey, kept.slice(-CLAUDE_ANNOUNCED_TOOL_USE_MAX_PER_PANE))
}

/** Forget a call that reported back: only calls that may still be waiting on a prompt stay resolvable. */
export function retireClaudeAnnouncedToolUse(
  store: ClaudeAnnouncedToolUseStore,
  paneKey: string,
  toolUseId: string | undefined
): void {
  const id = toolUseId?.trim()
  const entries = store.get(paneKey)
  if (!id || !entries) {
    return
  }
  const kept = entries.filter((entry) => entry.toolUseId !== id)
  if (kept.length === 0) {
    store.delete(paneKey)
    return
  }
  store.set(paneKey, kept)
}

/** The id of the announced call a permission request belongs to, or undefined when the pane cannot say.
 *  Resolution is exact and unambiguous: `toolInput` is a truncated preview (and absent for MCP tools), so
 *  two live calls can look identical — guessing between them would clear a dialog nobody answered. Read
 *  only, so a re-delivered prompt resolves to the same id and a replay cannot consume anything. */
export function resolveClaudeAnnouncedToolUseId(
  store: ClaudeAnnouncedToolUseStore,
  paneKey: string,
  request: ClaudeToolUseIdentity,
  now = Date.now()
): string | undefined {
  const entries = store.get(paneKey)
  if (!entries || request.toolName === undefined) {
    return undefined
  }
  const matches = entries.filter((entry) => isFresh(entry, now) && matchesIdentity(entry, request))
  return matches.length === 1 ? matches[0]?.toolUseId : undefined
}

/** Drop a pane's announcements — turn boundaries, where the previous turn's calls stop being relevant,
 *  and pane teardown, where nothing about the old process survives. */
export function forgetClaudeAnnouncedToolUses(
  store: ClaudeAnnouncedToolUseStore,
  paneKey: string
): void {
  store.delete(paneKey)
}

/** Drop announcements for every pane whose key satisfies `predicate` (tab close). */
export function forgetClaudeAnnouncedToolUsesWhere(
  store: ClaudeAnnouncedToolUseStore,
  predicate: (paneKey: string) => boolean
): void {
  // Why: deleting the current key while iterating a Map is well defined, so no copy is needed.
  for (const paneKey of store.keys()) {
    if (predicate(paneKey)) {
      store.delete(paneKey)
    }
  }
}

/** Follow a pane through an authority transfer, merging rather than replacing: a live destination pane has
 *  announcements of its own and dropping them would leave its prompts unresolvable. */
export function moveClaudeAnnouncedToolUses(
  store: ClaudeAnnouncedToolUseStore,
  fromPaneKey: string,
  toPaneKey: string
): void {
  if (fromPaneKey === toPaneKey) {
    return
  }
  const source = store.get(fromPaneKey)
  if (!source) {
    return
  }
  store.delete(fromPaneKey)
  const byId = new Map<string, ClaudeAnnouncedToolUse>()
  for (const entry of [...(store.get(toPaneKey) ?? []), ...source]) {
    const existing = byId.get(entry.toolUseId)
    if (existing === undefined || existing.recordedAt < entry.recordedAt) {
      byId.set(entry.toolUseId, entry)
    }
  }
  // Why: sort before the cap so the trim drops the oldest calls overall, not whichever pane came first.
  const merged = [...byId.values()]
    .sort((left, right) => left.recordedAt - right.recordedAt)
    .slice(-CLAUDE_ANNOUNCED_TOOL_USE_MAX_PER_PANE)
  if (merged.length === 0) {
    store.delete(toPaneKey)
    return
  }
  store.set(toPaneKey, merged)
}

export function clearClaudeAnnouncedToolUses(store: ClaudeAnnouncedToolUseStore): void {
  store.clear()
}
