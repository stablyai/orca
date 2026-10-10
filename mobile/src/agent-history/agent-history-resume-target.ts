import { parseExecutionHostId } from '../../../src/shared/execution-host'
import type { AiVaultSession } from '../../../src/shared/ai-vault-types'
import type { Worktree } from '../worktree/workspace-list-types'
import {
  getMobileAiVaultResumeTargetBlockReason,
  isMobileAiVaultWslFallbackResume,
  mobileAiVaultResumeTargetBlockMessage,
  type MobileAiVaultResumeBlockReason
} from './agent-history-resume-block-reason'
import {
  getMobileAiVaultResumeWorktreeTarget,
  type MobileAiVaultResumeFolderWorkspace,
  type MobileAiVaultResumeProjectGroup,
  type MobileAiVaultResumeRepo,
  type MobileAiVaultResumeWorkspaceTarget
} from './agent-history-resume-workspace-target'
export type {
  MobileAiVaultResumeFolderWorkspace,
  MobileAiVaultResumeProjectGroup,
  MobileAiVaultResumeRepo,
  MobileAiVaultResumeTargetStatus,
  MobileAiVaultResumeWorkspaceTarget
} from './agent-history-resume-workspace-target'
import {
  canResumeInMobileSessionWorktree,
  resolveMobileAgentHistorySessionWorktree,
  resolveMobileAgentHistorySessionWorktreeTies
} from './agent-history-session-worktree'

export type MobileAiVaultResumeReadyCandidate = {
  worktreeId: string
  targetStatus: 'local' | 'ssh'
  workspacePath: string | null
  terminalPlatform: NodeJS.Platform | null
  // SSH only: the host to verify the transcript on when the WSL-UNC guess alone allowed it.
  transcriptProbeHostId?: `ssh:${string}`
}

export type MobileAiVaultSessionResumeTarget =
  | (MobileAiVaultResumeReadyCandidate & {
      status: 'ready'
      // WSL fallback only: set when same-path workspaces on other SSH hosts tie with this one.
      // Ordered, first entry is this target, one entry per host, capped at
      // MAX_TRANSCRIPT_PROBE_CANDIDATES. The caller probes them and resumes into the first one
      // that holds the transcript.
      transcriptProbeCandidates?: MobileAiVaultResumeReadyCandidate[]
    })
  | { status: 'blocked'; message: string }

// Why: each probe is an RPC through the serving host to an SSH host; a handful of same-path
// workspaces is realistic, an unbounded fan-out is not.
export const MAX_TRANSCRIPT_PROBE_CANDIDATES = 4

export function resolveMobileAiVaultSessionResumeTarget(args: {
  session: AiVaultSession
  activeWorktreeId: string | null
  worktrees: readonly Worktree[]
  repos: readonly MobileAiVaultResumeRepo[]
  folderWorkspaces?: readonly MobileAiVaultResumeFolderWorkspace[]
  projectGroups?: readonly MobileAiVaultResumeProjectGroup[]
}): MobileAiVaultSessionResumeTarget {
  const sessionWorktree = resolveMobileAgentHistorySessionWorktree({
    session: args.session,
    worktrees: args.worktrees,
    activeWorktreeId: args.activeWorktreeId
  })
  const sessionWorktreeId = canResumeInMobileSessionWorktree(sessionWorktree)
    ? sessionWorktree?.worktreeId
    : null
  const candidateWorktreeIds = [
    sessionWorktreeId,
    args.activeWorktreeId && args.activeWorktreeId !== sessionWorktreeId
      ? args.activeWorktreeId
      : null
  ].filter((candidate): candidate is string => Boolean(candidate))

  let firstBlocked: {
    target: MobileAiVaultResumeWorkspaceTarget
    reason: MobileAiVaultResumeBlockReason | null
  } | null = null
  for (const candidateWorktreeId of candidateWorktreeIds) {
    const target = getMobileAiVaultResumeWorktreeTarget({
      worktreeId: candidateWorktreeId,
      worktrees: args.worktrees,
      repos: args.repos,
      folderWorkspaces: args.folderWorkspaces,
      projectGroups: args.projectGroups
    })
    const reason = getMobileAiVaultResumeTargetBlockReason({ session: args.session, target })
    if (reason || (target.status !== 'local' && target.status !== 'ssh')) {
      firstBlocked ??= { target, reason }
      continue
    }
    const ready = buildReadyCandidate({ ...args, worktreeId: candidateWorktreeId, target })
    const tied =
      ready.transcriptProbeHostId && candidateWorktreeId === sessionWorktreeId
        ? collectTiedProbeCandidates({ ...args, first: ready })
        : []
    return {
      status: 'ready',
      ...ready,
      ...(tied.length > 1 ? { transcriptProbeCandidates: tied } : {})
    }
  }

  const blocked =
    firstBlocked ??
    ({
      target: getMobileAiVaultResumeWorktreeTarget({
        worktreeId: args.activeWorktreeId,
        worktrees: args.worktrees,
        repos: args.repos,
        folderWorkspaces: args.folderWorkspaces,
        projectGroups: args.projectGroups
      }),
      reason: null
    } as const)
  return {
    status: 'blocked',
    message: mobileAiVaultResumeTargetBlockMessage(blocked.target.status, blocked.reason)
  }
}

function buildReadyCandidate(args: {
  session: AiVaultSession
  worktrees: readonly Worktree[]
  worktreeId: string
  target: MobileAiVaultResumeWorkspaceTarget
}): MobileAiVaultResumeReadyCandidate {
  const worktree = args.worktrees.find((candidate) => candidate.worktreeId === args.worktreeId)
  const parsedHost = parseExecutionHostId(args.target.hostId)
  const probeHostId = parsedHost?.kind === 'ssh' ? parsedHost.id : null
  return {
    worktreeId: args.worktreeId,
    targetStatus: args.target.status === 'ssh' ? 'ssh' : 'local',
    workspacePath: worktree?.path ?? null,
    terminalPlatform: worktree?.terminalPlatform ?? null,
    ...(probeHostId &&
    isMobileAiVaultWslFallbackResume({ session: args.session, target: args.target })
      ? { transcriptProbeHostId: probeHostId }
      : {})
  }
}

// Why: a WSL row is tagged local, so only the session cwd picks the workspace, and equal-length
// cwd matches tie. Same-path checkouts on different SSH hosts would otherwise be picked by list
// order, and a verified `missing` on the wrong host would refuse a resume the right host serves.
// Non-tie cases return a single entry, which callers treat as "no extra candidates".
function collectTiedProbeCandidates(args: {
  session: AiVaultSession
  worktrees: readonly Worktree[]
  repos: readonly MobileAiVaultResumeRepo[]
  folderWorkspaces?: readonly MobileAiVaultResumeFolderWorkspace[]
  projectGroups?: readonly MobileAiVaultResumeProjectGroup[]
  first: MobileAiVaultResumeReadyCandidate
}): MobileAiVaultResumeReadyCandidate[] {
  const candidates = [args.first]
  const seenHosts = new Set([args.first.transcriptProbeHostId])
  const tiedIds = resolveMobileAgentHistorySessionWorktreeTies({
    session: args.session,
    worktrees: args.worktrees
  })
  for (const worktreeId of tiedIds) {
    if (candidates.length >= MAX_TRANSCRIPT_PROBE_CANDIDATES) {
      break
    }
    if (worktreeId === args.first.worktreeId) {
      continue
    }
    const target = getMobileAiVaultResumeWorktreeTarget({ ...args, worktreeId })
    if (getMobileAiVaultResumeTargetBlockReason({ session: args.session, target })) {
      continue
    }
    const candidate = buildReadyCandidate({ ...args, worktreeId, target })
    if (!candidate.transcriptProbeHostId || seenHosts.has(candidate.transcriptProbeHostId)) {
      continue
    }
    seenHosts.add(candidate.transcriptProbeHostId)
    candidates.push(candidate)
  }
  return candidates
}
