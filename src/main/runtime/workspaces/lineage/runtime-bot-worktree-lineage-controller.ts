import { readActingSessionWorkspaceKey } from '../../rpc/orchestration/callers/orchestration-session-caller'
import type { ExecutionHostId } from '../../../../shared/execution-host/execution-host'
import { botCreatedLineage, resolveBotHomeCaller } from './runtime-bot-created-lineage'
import { RuntimeWorktreeLineageController } from './runtime-worktree-lineage-controller'
import {
  enforceCreateLineageHostBoundary,
  type WorktreeLineageInput,
  type WorktreeLineageResolution
} from './runtime-worktree-lineage-resolution'

type LineageDeps = ConstructorParameters<typeof RuntimeWorktreeLineageController>[0]
type BotLineageDeps = LineageDeps & {
  /** The workspace key an acting agent session on this host runs in; rejects any other claim. */
  getSessionWorkspaceKey(sessionId: string): Promise<string>
}

/** Lineage where a create from a session or terminal in a bot's home is the bot's. */
export class BotWorktreeLineageController extends RuntimeWorktreeLineageController {
  private readonly botDeps: BotLineageDeps

  /** A runtime's controller reads session claims as acting sessions, refusing other hosts' ids. */
  static forRuntime(
    runtime: Parameters<typeof readActingSessionWorkspaceKey>[0],
    deps: LineageDeps
  ): BotWorktreeLineageController {
    return new BotWorktreeLineageController({
      ...deps,
      getSessionWorkspaceKey: (id) => readActingSessionWorkspaceKey(runtime, id, 'worktree.create')
    })
  }

  constructor(deps: BotLineageDeps) {
    super(deps)
    this.botDeps = deps
  }

  override async resolveCreate(
    input?: WorktreeLineageInput,
    childHostId?: ExecutionHostId
  ): Promise<WorktreeLineageResolution> {
    const botHome = await resolveBotHomeCaller(input, {
      deps: this.botDeps,
      resolveParent: (selector) => this.resolveParent(selector),
      showCallerTerminal: (handle) => this.botDeps.showTerminal(handle)
    })
    if (!botHome || !input) {
      return super.resolveCreate(input, childHostId)
    }
    // The bot's home replaces an ambiguous cwd parent, so that ambiguity refuses nothing here.
    const { cwdParentAmbiguous: _ambiguous, ...unambiguous } = input
    const resolution = await super.resolveCreate(unambiguous, childHostId)
    return enforceCreateLineageHostBoundary(botCreatedLineage(resolution, botHome), childHostId)
  }
}
