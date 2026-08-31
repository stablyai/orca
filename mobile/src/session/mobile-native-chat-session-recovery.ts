import { AGENT_STATUS_STALE_AFTER_MS } from '../../../src/shared/agent-status-types'

/** A terminal tab as the recovery resolver sees it: which agent owns it and
 *  whether that agent already published a transcript address. */
export type MobileNativeChatRecoveryTab = {
  id: string
  agent: string | null
  sessionId: string | null
}

/** One scanned transcript from the host's session index (`aiVault.listSessions`),
 *  narrowed to the fields adoption depends on. */
export type MobileNativeChatRecoveryCandidate = {
  agent: string
  sessionId: string
  /** On-disk transcript path, forwarded verbatim to `nativeChat.subscribe`. */
  filePath: string
  cwd: string | null
  /** ISO timestamp of the last write; the only liveness signal a scan carries. */
  modifiedAt: string
  /** Task subagent transcripts are never a pane's own conversation. */
  isSubagent: boolean
}

export type MobileNativeChatRecoveredSession = {
  sessionId: string
  transcriptPath: string
}

// Why this window: a transcript older than the agent-status staleness bound
// cannot belong to a pane Orca still reports as live, and adopting it would show
// a finished conversation under a running agent.
const RECOVERY_MAX_AGE_MS = AGENT_STATUS_STALE_AFTER_MS

function parseModifiedAt(value: string): number | null {
  const parsed = Date.parse(value)
  return Number.isFinite(parsed) ? parsed : null
}

/**
 * Adopt a transcript for a pane whose agent never published a provider session —
 * a hand-started agent, or one whose hook identity never reached the host.
 *
 * Refuses unless the choice is unambiguous, because showing another agent's
 * conversation is a worse failure than an honest "no conversation linked" state:
 *
 * - another tab in this worktree runs the same agent with no address either
 *   (nothing distinguishes which transcript belongs to which pane);
 * - the candidate is already the address of some other tab;
 * - the candidate is a Task subagent transcript, sits in a different cwd, or has
 *   not been written within the agent-status staleness window.
 *
 * The newest surviving candidate wins: a live session is the one still being
 * appended to.
 */
export function resolveMobileNativeChatRecoveredSession(args: {
  tabId: string
  agent: string
  /** The pane's working directory; candidates from elsewhere are refused. */
  cwd: string | null
  tabs: readonly MobileNativeChatRecoveryTab[]
  candidates: readonly MobileNativeChatRecoveryCandidate[]
  now: number
}): MobileNativeChatRecoveredSession | null {
  const { tabId, agent, cwd, tabs, candidates, now } = args
  const rival = tabs.some(
    (tab) => tab.id !== tabId && tab.agent === agent && tab.sessionId === null
  )
  if (rival) {
    return null
  }
  const claimed = new Set(tabs.flatMap((tab) => (tab.sessionId !== null ? [tab.sessionId] : [])))
  let best: { candidate: MobileNativeChatRecoveryCandidate; modifiedAt: number } | null = null
  for (const candidate of candidates) {
    if (candidate.agent !== agent || candidate.isSubagent) {
      continue
    }
    if (claimed.has(candidate.sessionId) || !candidate.filePath) {
      continue
    }
    if (cwd !== null && candidate.cwd !== null && candidate.cwd !== cwd) {
      continue
    }
    const modifiedAt = parseModifiedAt(candidate.modifiedAt)
    if (modifiedAt === null || now - modifiedAt > RECOVERY_MAX_AGE_MS) {
      continue
    }
    if (!best || modifiedAt > best.modifiedAt) {
      best = { candidate, modifiedAt }
    }
  }
  if (!best) {
    return null
  }
  return { sessionId: best.candidate.sessionId, transcriptPath: best.candidate.filePath }
}
