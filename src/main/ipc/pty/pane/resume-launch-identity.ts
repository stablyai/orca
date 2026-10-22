import { agentHookServer } from '../../../agent-hooks/server'
import {
  isResumableTuiAgent,
  normalizeAgentProviderSession
} from '../../../../shared/agent-session-resume'
import type { PtySpawnResult } from '../../../providers/pty-provider-contract'

/**
 * Record a fresh resume launch's provider session in the hook store, so every reader (phone tab
 * list, native chat, worktree ps) can address the transcript before the agent's first hook.
 * Both spawn choke points (renderer pty:spawn and the runtime controller) call this.
 */
export function seedResumeLaunchIdentityFromSpawn(args: {
  paneKey: string | null | undefined
  launchAgent: unknown
  resumeProviderSession: unknown
  connectionId: string | null | undefined
  worktreeId: unknown
  launchedAt: Date | undefined
  /** The Codex resume fell back to a fresh session, so the pane does not hold this one. */
  resumeArgvDropped: boolean
  result: PtySpawnResult
}): void {
  // Why: a reattached process already reported its own identity; an SSH pane's rows belong to
  // its relay, which owns that host's status.
  if (
    !args.paneKey ||
    args.resumeArgvDropped ||
    args.result.isReattach === true ||
    args.connectionId ||
    !args.launchedAt
  ) {
    return
  }
  seedResumeLaunchIdentity({
    ...args,
    paneKey: args.paneKey,
    launchedAt: args.launchedAt.getTime()
  })
}

/**
 * Record a resume the host did not spawn as a command: a phone resuming from Session History
 * creates a shell pane and types the resume into it. Callers rule out SSH panes themselves.
 */
export function seedResumeLaunchIdentity(args: {
  paneKey: string
  launchAgent: unknown
  resumeProviderSession: unknown
  worktreeId: unknown
  launchedAt: number
}): void {
  const agent = args.launchAgent
  const providerSession = normalizeAgentProviderSession(args.resumeProviderSession)
  if (!providerSession || !isResumableTuiAgent(agent)) {
    return
  }
  // Why: Pi-family resumes are addressed by transcript file, not id; without it the row is invalid.
  if ((agent === 'pi' || agent === 'prime-agent') && !providerSession.transcriptPath) {
    return
  }
  agentHookServer.recordLaunchResumeIdentity({
    paneKey: args.paneKey,
    ...(typeof args.worktreeId === 'string' ? { worktreeId: args.worktreeId } : {}),
    agentType: agent,
    providerSession,
    launchedAt: args.launchedAt
  })
}
