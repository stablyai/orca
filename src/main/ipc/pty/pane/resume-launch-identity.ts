import { agentHookServer } from '../../../agent-hooks/server'
import {
  isResumableTuiAgent,
  normalizeAgentProviderSession
} from '../../../../shared/agent-session-resume'
import type { PtySpawnResult } from '../../../providers/pty-provider-contract'

/** Both spawn entry points seed resume identity before the first hook so phone/chat/process readers can address its transcript. */
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
  // Reattach already owns identity; SSH status rows belong to the relay.
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

/** Seed resumes typed into existing shell panes, including phone Session History; callers exclude SSH. */
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
  // Pi-family resumes require transcript paths, not session IDs alone.
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
