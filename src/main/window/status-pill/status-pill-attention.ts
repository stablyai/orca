/** Minimal structural shape the attention detector reads. Both the IPC
 *  snapshot payload (AgentStatusIpcPayload) and the raw hook status-change
 *  entry (AgentHookStatusChangeEntry) satisfy it, so the detector works on
 *  whichever the caller hands it without coupling to either concrete type. */
export type StatusPillAttentionEntry = {
  // Why: paneKey is optional on the raw hook status-change entry, so the
  // detector treats a missing paneKey as "not attention-worthy" rather than
  // fail to type-check against either concrete payload type.
  paneKey?: string | null
  state?: string | null
  agentType?: string | null
  toolName?: string | null
  interactivePrompt?: string | null
  worktreeId?: string | null
  providerSessionOnly?: boolean
}

/** A pane that newly entered an attention state (waiting/blocked with a live
 *  interactive prompt) since the previous snapshot, and is eligible for an
 *  alert. The coordinator turns each of these into a dock bounce + OS
 *  notification + pill pulse. */
export type StatusPillAttentionTransition = {
  paneKey: string
  agentType: string
  interactivePrompt: string
  toolName?: string
  worktreeId?: string
  /** 'blocked' outranks 'waiting' so a permission prompt wins the single
   *  per-batch alert when several agents ask at once. */
  urgency: 'blocked' | 'waiting'
}

/** Default per-pane cooldown: once we have alerted about a pane, ignore
 *  further attention transitions for it until this much time has passed (even
 *  if it briefly left and re-entered the attention state). */
export const STATUS_PILL_ATTENTION_COOLDOWN_MS = 30_000

/** True when an entry represents an agent currently needing the user: it is in
 *  a waiting/blocked state and carries a non-empty interactive prompt. */
function isAttentionEntry(entry: StatusPillAttentionEntry | null | undefined): boolean {
  if (!entry || entry.providerSessionOnly === true) {
    return false
  }
  if (entry.state !== 'waiting' && entry.state !== 'blocked') {
    return false
  }
  return typeof entry.interactivePrompt === 'string' && entry.interactivePrompt.length > 0
}

/** Compute the set of panes that newly need attention, given the previous and
 *  current snapshots. A pane is "new" only if it is attentive now AND was not
 *  attentive in the previous snapshot (so a pane that was already waiting does
 *  not re-fire on every status tick). A per-pane cooldown further suppresses
 *  leave→re-enter flicker.
 *
 *  This is pure: it reads `cooldowns` but does not mutate it. The caller is
 *  responsible for stamping `cooldowns.set(paneKey, now)` for every returned
 *  transition so the cooldown takes effect. */
export function computeStatusPillAttentionTransitions(
  previous: StatusPillAttentionEntry[],
  next: StatusPillAttentionEntry[],
  now: number,
  cooldowns: Map<string, number>,
  cooldownMs: number = STATUS_PILL_ATTENTION_COOLDOWN_MS
): StatusPillAttentionTransition[] {
  const previouslyAttentive = new Set<string>()
  for (const entry of previous ?? []) {
    if (isAttentionEntry(entry) && entry.paneKey) {
      previouslyAttentive.add(entry.paneKey)
    }
  }

  const transitions: StatusPillAttentionTransition[] = []
  for (const entry of next ?? []) {
    if (!isAttentionEntry(entry) || !entry.paneKey) {
      continue
    }
    const paneKey = entry.paneKey
    // Why: a pane already attentive in the previous snapshot is not a *new*
    // attention event — it has already alerted the user (the pill is expanded
    // + pulsing). Only genuine transitions fire an alert.
    if (previouslyAttentive.has(paneKey)) {
      continue
    }
    const lastAlert = cooldowns.get(paneKey)
    if (lastAlert !== undefined && now - lastAlert < cooldownMs) {
      continue
    }
    transitions.push({
      paneKey,
      agentType: entry.agentType ?? 'agent',
      interactivePrompt: entry.interactivePrompt ?? '',
      toolName: typeof entry.toolName === 'string' ? entry.toolName : undefined,
      worktreeId: entry.worktreeId ?? undefined,
      urgency: entry.state === 'blocked' ? 'blocked' : 'waiting'
    })
  }

  // Why: when several agents ask at once, surface the most urgent first so the
  // single per-batch OS notification + dock bounce targets the permission
  // prompt (blocked) over a generic question (waiting).
  transitions.sort((a, b) => {
    if (a.urgency !== b.urgency) {
      return a.urgency === 'blocked' ? -1 : 1
    }
    return 0
  })
  return transitions
}
