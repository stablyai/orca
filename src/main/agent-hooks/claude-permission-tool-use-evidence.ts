// Why: Claude's PermissionRequest carries no `tool_use_id`, so a pane must remember the ids announced in
// `PreToolUse` to prove the approved call resumed; a sibling of a parallel batch sits between the two.

export type ClaudePendingToolUse = {
  toolUseId: string
  toolName: string
  toolInput?: string
  toolAgentId?: string
  toolAgentType?: string
  recordedAt: number
}

type ClaudePaneToolUseLedger = {
  /** Claimable calls; turn-scoped. */
  pending: ClaudePendingToolUse[]
  /** id → announcement time; outlives the turn so a retried completion still reads as already seen. */
  announced: Map<string, number>
  completed: Set<string>
}

export type ClaudePendingToolUseStore = Map<string, ClaudePaneToolUseLedger>

// Why: one bound for both stores — a call the pane still remembers announcing must stay claimable.
export const CLAUDE_PENDING_TOOL_USE_MAX_PER_PANE = 64

// Why: backstop for a turn that ends without a Stop hook; must outlast a human staring at a prompt.
export const CLAUDE_PENDING_TOOL_USE_TTL_MS = 60 * 60_000

type ClaudeToolUseIdentity = {
  toolUseId?: string
  toolName?: string
  toolInput?: string
  toolAgentId?: string
  toolAgentType?: string
}

function isFresh(entry: ClaudePendingToolUse, now: number): boolean {
  return now - entry.recordedAt <= CLAUDE_PENDING_TOOL_USE_TTL_MS
}

function matchesPendingToolUse(
  entry: ClaudePendingToolUse,
  request: ClaudeToolUseIdentity
): boolean {
  if (entry.toolName !== request.toolName) {
    return false
  }
  if (entry.toolAgentId !== request.toolAgentId || entry.toolAgentType !== request.toolAgentType) {
    return false
  }
  // Why: exact equality — one known and one unknown input would let a permission adopt a sibling's id.
  return entry.toolInput === request.toolInput
}

function ledgerFor(store: ClaudePendingToolUseStore, paneKey: string): ClaudePaneToolUseLedger {
  const existing = store.get(paneKey)
  if (existing) {
    return existing
  }
  const created: ClaudePaneToolUseLedger = {
    pending: [],
    announced: new Map<string, number>(),
    completed: new Set<string>()
  }
  store.set(paneKey, created)
  return created
}

// Why: re-inserting moves an id to the end, so the trim drops genuinely old ones.
function trimOldestIds(ids: {
  size: number
  keys: () => IterableIterator<string>
  delete: (id: string) => boolean
}): void {
  while (ids.size > CLAUDE_PENDING_TOOL_USE_MAX_PER_PANE) {
    const oldest = ids.keys().next().value
    if (oldest === undefined) {
      return
    }
    ids.delete(oldest)
  }
}

function rememberAnnouncedId(announced: Map<string, number>, toolUseId: string, at: number): void {
  announced.delete(toolUseId)
  announced.set(toolUseId, at)
  trimOldestIds(announced)
}

function rememberCompletedId(completed: Set<string>, toolUseId: string): void {
  completed.delete(toolUseId)
  completed.add(toolUseId)
  trimOldestIds(completed)
}

function pruneLedger(
  ledger: ClaudePaneToolUseLedger,
  store: ClaudePendingToolUseStore,
  paneKey: string
): void {
  if (ledger.pending.length === 0 && ledger.announced.size === 0 && ledger.completed.size === 0) {
    store.delete(paneKey)
  }
}

/** Record the id Claude announced for a tool call. Safe to call for every live claude `PreToolUse`. */
export function rememberClaudePendingToolUse(
  store: ClaudePendingToolUseStore,
  paneKey: string,
  toolUse: ClaudeToolUseIdentity,
  now = Date.now()
): void {
  const toolUseId = toolUse.toolUseId?.trim()
  const toolName = toolUse.toolName?.trim()
  if (!toolUseId || !toolName) {
    return
  }
  const ledger = ledgerFor(store, paneKey)
  const entry: ClaudePendingToolUse = {
    toolUseId,
    toolName,
    ...(toolUse.toolInput !== undefined ? { toolInput: toolUse.toolInput } : {}),
    ...(toolUse.toolAgentId !== undefined ? { toolAgentId: toolUse.toolAgentId } : {}),
    ...(toolUse.toolAgentType !== undefined ? { toolAgentType: toolUse.toolAgentType } : {}),
    recordedAt: now
  }
  // Why: a retried announcement refreshes its entry; a duplicate would be claimed by the wrong prompt.
  const kept = ledger.pending.filter(
    (candidate) => candidate.toolUseId !== toolUseId && isFresh(candidate, now)
  )
  kept.push(entry)
  ledger.pending =
    kept.length > CLAUDE_PENDING_TOOL_USE_MAX_PER_PANE
      ? kept.slice(kept.length - CLAUDE_PENDING_TOOL_USE_MAX_PER_PANE)
      : kept
  rememberAnnouncedId(ledger.announced, toolUseId, now)
}

/** Retire a call that reported back: its id can no longer be claimed by a later permission request.
 *  Creates the pane's ledger when absent — a completion seen before any announcement still has to be
 *  remembered, or its retry would look like an unannounced call and answer the next prompt. */
export function retireClaudeCompletedToolUse(
  store: ClaudePendingToolUseStore,
  paneKey: string,
  toolUseId: string | undefined
): void {
  const id = toolUseId?.trim()
  if (!id) {
    return
  }
  const ledger = ledgerFor(store, paneKey)
  ledger.pending = ledger.pending.filter((entry) => entry.toolUseId !== id)
  rememberCompletedId(ledger.completed, id)
}

/** Claim the oldest matching announced call, removing it so the batch's next prompt claims the next one. */
export function takeClaudePendingToolUseId(
  store: ClaudePendingToolUseStore,
  paneKey: string,
  request: ClaudeToolUseIdentity,
  now = Date.now()
): string | undefined {
  const ledger = store.get(paneKey)
  if (!ledger || request.toolName === undefined) {
    return undefined
  }
  // Why: oldest-first — Claude prompts in announcement order, so calls sharing an input preview pair up.
  const index = ledger.pending.findIndex(
    (entry) => isFresh(entry, now) && matchesPendingToolUse(entry, request)
  )
  if (index < 0) {
    return undefined
  }
  const claimed = ledger.pending[index]
  ledger.pending = ledger.pending.filter((entry, at) => at !== index && isFresh(entry, now))
  return claimed?.toolUseId
}

/** True when the id traces to no call this pane had announced by `announcedBefore` — the signature of the
 *  call a prompt waits on, as opposed to a retry, a replay, a batch sibling or an earlier turn. */
export function isClaudeToolUseUnaccountedFor(
  store: ClaudePendingToolUseStore,
  paneKey: string,
  toolUseId: string | undefined,
  announcedBefore: number
): boolean {
  const id = toolUseId?.trim()
  if (!id) {
    return false
  }
  const ledger = store.get(paneKey)
  if (!ledger) {
    return true
  }
  if (ledger.completed.has(id)) {
    return false
  }
  const announcedAt = ledger.announced.get(id)
  return announcedAt === undefined || announcedAt >= announcedBefore
}

/** Drop what a pane can still claim, keeping the seen-id history: a new turn must not adopt the previous
 *  turn's call, yet a completion retried across the boundary must still read as a repeat. */
export function forgetClaudeClaimableToolUses(
  store: ClaudePendingToolUseStore,
  paneKey: string
): void {
  const ledger = store.get(paneKey)
  if (!ledger) {
    return
  }
  ledger.pending = []
  pruneLedger(ledger, store, paneKey)
}

/** Drop a pane's evidence entirely — pane teardown, where nothing about the old process stays relevant. */
export function forgetClaudePendingToolUses(
  store: ClaudePendingToolUseStore,
  paneKey: string
): void {
  store.delete(paneKey)
}

/** Drop evidence for every pane whose key satisfies `predicate` (tab close). */
export function forgetClaudePendingToolUsesWhere(
  store: ClaudePendingToolUseStore,
  predicate: (paneKey: string) => boolean
): void {
  // Why: deleting the current key while iterating a Map is well defined, so no copy is needed.
  for (const paneKey of store.keys()) {
    if (predicate(paneKey)) {
      store.delete(paneKey)
    }
  }
}

function mergeLedgers(destination: ClaudePaneToolUseLedger, source: ClaudePaneToolUseLedger): void {
  const pendingById = new Map<string, ClaudePendingToolUse>()
  for (const entry of [...destination.pending, ...source.pending]) {
    const existing = pendingById.get(entry.toolUseId)
    if (existing === undefined || existing.recordedAt < entry.recordedAt) {
      pendingById.set(entry.toolUseId, entry)
    }
  }
  destination.pending = [...pendingById.values()]
    .sort((left, right) => left.recordedAt - right.recordedAt)
    .slice(-CLAUDE_PENDING_TOOL_USE_MAX_PER_PANE)
  for (const [toolUseId, announcedAt] of source.announced) {
    const existing = destination.announced.get(toolUseId)
    if (existing === undefined || existing < announcedAt) {
      destination.announced.set(toolUseId, announcedAt)
    }
  }
  destination.announced = new Map(
    [...destination.announced.entries()]
      .sort((left, right) => left[1] - right[1])
      .slice(-CLAUDE_PENDING_TOOL_USE_MAX_PER_PANE)
  )
  const completed = [...destination.completed, ...source.completed]
  destination.completed = new Set(completed.slice(-CLAUDE_PENDING_TOOL_USE_MAX_PER_PANE))
}

/** Follow a pane through an authority transfer so its batch evidence stays reachable. Merges rather than
 *  replaces: a destination pane that has been live has evidence of its own, and dropping it would leave its
 *  prompts unable to attach an id. */
export function moveClaudePendingToolUses(
  store: ClaudePendingToolUseStore,
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
  const destination = store.get(toPaneKey)
  if (!destination) {
    store.set(toPaneKey, source)
    pruneLedger(source, store, toPaneKey)
    return
  }
  mergeLedgers(destination, source)
  pruneLedger(destination, store, toPaneKey)
}

export function clearClaudePendingToolUses(store: ClaudePendingToolUseStore): void {
  store.clear()
}
