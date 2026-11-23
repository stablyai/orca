import { folderWorkspaceKey } from '../../../../shared/workspace/identity/workspace-scope'
import type {
  ResolvedWorkspaceParent,
  WorktreeLineageInput,
  WorktreeLineageResolution
} from './runtime-worktree-lineage-resolution'
import type { RuntimeStore } from '../../construction/runtime-store-contract'

/** A create from a session in a bot's home is the bot's whatever parent flag its agent chose (or skipped); only a worker's own link or an explicit other parent outranks it. */
export function botCreatedLineage(
  resolution: WorktreeLineageResolution,
  botHome: ResolvedWorkspaceParent | null
): WorktreeLineageResolution {
  // A parent on another machine is always one the caller named.
  if (!botHome || resolution.kind === 'crossStore') {
    return resolution
  }

  if (
    resolution.kind === 'lineage' &&
    (resolution.origin === 'orchestration' ||
      (resolution.capture.confidence === 'explicit' &&
        resolution.parent.workspaceKey !== botHome.workspaceKey))
  ) {
    return resolution
  }
  // The bot coordinates its home's work, so its own creates carry the same origin its workers' do.
  return {
    kind: 'lineage',
    parent: botHome,
    origin: 'orchestration',
    capture: { source: 'orchestration-context', confidence: 'explicit' }
  }
}

/** The bot home the creating session or terminal runs in, if any. */
export async function resolveBotHomeCaller(
  input: WorktreeLineageInput | undefined,
  lineage: {
    deps: {
      getStore(): RuntimeStore | null
      getSessionWorkspaceKey(sessionId: string): Promise<string>
    }
    resolveParent: (selector: string) => Promise<ResolvedWorkspaceParent>
    showCallerTerminal: (handle: string) => Promise<{ worktreeId: string }>
  }
): Promise<ResolvedWorkspaceParent | null> {
  const bots = lineage.deps.getStore()?.getBots?.() ?? []
  if (!input || bots.length === 0) {
    return null
  }
  const callerWorkspaceKey =
    (input.callerAgentSessionId &&
      (await lineage.deps
        .getSessionWorkspaceKey(input.callerAgentSessionId)
        .catch(() => undefined))) ||
    (input.callerTerminalHandle &&
      (await lineage.showCallerTerminal(input.callerTerminalHandle).then(
        (terminal) => terminal.worktreeId,
        () => undefined
      )))
  if (
    !callerWorkspaceKey ||
    !bots.some((bot) => folderWorkspaceKey(bot.folderWorkspaceId) === callerWorkspaceKey)
  ) {
    return null
  }
  return lineage.resolveParent(callerWorkspaceKey).catch(() => null)
}
