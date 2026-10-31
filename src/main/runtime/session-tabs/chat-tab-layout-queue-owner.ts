import { createChatTabLayoutQueue } from '../agent-session-tab-layout-queue'
import type { LayoutCommandRunOptions, WindowLayoutCommand } from '../runtime-layout-apply'
import type { LayoutApplyReply } from '../../../shared/workspace-layout/workspace-layout-command-types'
import { OrcaRuntimeWithStructuredSessionTabProjection } from './restored-chat-tab-changes'

/** Chat tab opens and closes main applies to the layout it owns, one at a time. */
export abstract class OrcaRuntimeWithChatTabLayoutQueue extends OrcaRuntimeWithStructuredSessionTabProjection {
  abstract applyLayoutCommand(
    command: WindowLayoutCommand,
    options?: LayoutCommandRunOptions
  ): Promise<LayoutApplyReply>
  protected readonly queueChatTabChanges = createChatTabLayoutQueue({
    sessionOf: (worktreeId) => this.getWorkspaceSessionForWorktree(worktreeId),
    hostIdOf: (worktreeId) => this.getWorkspaceSessionHostIdForWorktree(worktreeId),
    apply: (command, options) => this.applyLayoutCommand(command, options)
  })
}
