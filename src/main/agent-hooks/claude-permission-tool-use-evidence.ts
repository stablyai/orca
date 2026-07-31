// Why: Claude's PermissionRequest hook carries no `tool_use_id`, so a permission wait can only be released
// once the approved tool proves it resumed. The proof is the id Claude announced in the matching
// `PreToolUse`, which the server must remember per pane: with a parallel tool batch the previously cached
// event belongs to a sibling call, so the id is not reachable from it.
//
// The ledger is turn-scoped. Besides the queue of announced-but-unclaimed calls it keeps when this pane
// announced each id and which ids have already completed, because "an id this pane had not announced when
// the prompt appeared" is what separates the approved call reporting back from a retried, replayed or
// sibling completion.

export type ClaudePendingToolUse = {
  toolUseId: string
  toolName: string
  toolInput?: string
  toolAgentId?: string
  toolAgentType?: string
  recordedAt: number
}

type ClaudePaneToolUseLedger = {
  pending: ClaudePendingToolUse[]
  /** id → the moment this pane announced it, so a completion can be told apart from one whose
   *  announcement only arrived after the prompt was already on screen. */
  announced: Map<string, number>
  completed: Set<string>
}

export type ClaudePendingToolUseStore = Map<string, ClaudePaneToolUseLedger>

// Why: the queue and the id history share one bound on purpose — a call the pane still remembers announcing
// must stay claimable, or its prompt could never attach an id while the ledger insists the id is accounted
// for, and the pane would sit amber for the rest of the turn.
export const CLAUDE_PENDING_TOOL_USE_MAX_PER_PANE = 64

// Why: the ledger is cleared at every turn boundary, so the TTL only bounds ids left behind by a turn that
// ended without a Stop hook (kill, crash, lost POST). It must outlast a human staring at a prompt, since
// the turn stays open the whole time.
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
  // Why: an unknown input on both sides is still the same call as long as the identity fields above agree;
  // one known and one unknown is not, or a permission would adopt a sibling's id.
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

function rememberId(ids: Set<string> | Map<string, number>, toolUseId: string, at?: number): void {
  // Why: re-adding moves the id to the end, so the trim below drops genuinely old ids.
  ids.delete(toolUseId)
  if (ids instanceof Map) {
    ids.set(toolUseId, at ?? 0)
  } else {
    ids.add(toolUseId)
  }
  while (ids.size > CLAUDE_PENDING_TOOL_USE_MAX_PER_PANE) {
    const oldest = ids.keys().next().value
    if (oldest === undefined) {
      return
    }
    ids.delete(oldest)
  }
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
  // Why: a retried POST of the same announcement must refresh its entry, not queue a duplicate that the
  // next permission would claim in place of its own call.
  const kept = ledger.pending.filter(
    (candidate) => candidate.toolUseId !== toolUseId && isFresh(candidate, now)
  )
  kept.push(entry)
  ledger.pending =
    kept.length > CLAUDE_PENDING_TOOL_USE_MAX_PER_PANE
      ? kept.slice(kept.length - CLAUDE_PENDING_TOOL_USE_MAX_PER_PANE)
      : kept
  rememberId(ledger.announced, toolUseId, now)
}

/** Retire a call that reported back: its id can no longer be claimed by a later permission request. */
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
  rememberId(ledger.completed, id)
}

/** Claim the id of the oldest announced call matching this permission request, removing it so the next
 *  prompt of the same batch claims the next one. Undefined when the pane announced nothing usable. */
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
  // Why: oldest-first. Claude prompts for a batch in announcement order, so two calls that share a
  // truncated input preview must be claimed in that order or each prompt adopts its sibling's id.
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

/** True when this id cannot be traced to a call this pane had already announced by `announcedBefore` — it
 *  is either a call whose `PreToolUse` never reached us, or one announced only after that moment. That is
 *  the signature of the call a permission prompt is waiting on, as opposed to a retried or replayed
 *  completion, a sibling of the same batch, or a call from an earlier turn. */
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

/** Drop a pane's evidence — pane teardown, and the turn boundaries that make older ids meaningless. */
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

/** Follow a pane through an authority transfer so its batch evidence stays reachable. */
export function moveClaudePendingToolUses(
  store: ClaudePendingToolUseStore,
  fromPaneKey: string,
  toPaneKey: string
): void {
  if (fromPaneKey === toPaneKey) {
    return
  }
  const ledger = store.get(fromPaneKey)
  store.delete(fromPaneKey)
  if (ledger) {
    store.set(toPaneKey, ledger)
    pruneLedger(ledger, store, toPaneKey)
  }
}

export function clearClaudePendingToolUses(store: ClaudePendingToolUseStore): void {
  store.clear()
}
