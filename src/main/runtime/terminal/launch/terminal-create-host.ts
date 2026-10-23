import { OrcaRuntimeWithTerminalCreateDeduplication } from './terminal-create-deduplication'
import * as hostCreate from '../../terminal-create-host-forwarding'
import { startInAdmittedPane } from '../../runtime-pane-admission'
import { allocateTerminalPaneIdentity } from '../../runtime-terminal-pane-identity'

export abstract class OrcaRuntimeWithHostTerminalCreate extends OrcaRuntimeWithTerminalCreateDeduplication {
  createTerminalOnHost = async (params: hostCreate.TerminalHostCreateParams) => {
    const transport = this.orchestrationEnvironmentTransport
    const resolveWorkspace = this.resolveTerminalWorkspaceLaunchTarget.bind(this)
    if (!params.worktree) {
      return hostCreate.forwardTerminalCreate(params, { resolveWorkspace, transport })
    }
    const source = await resolveWorkspace(params.worktree)
    const workspace = source.scope.id
    // Why the caller's ids: the window draws this same tab, so main and the window share one identity.
    const { tabId, leafId } = allocateTerminalPaneIdentity(params)
    const hostStamp = {
      setup: params.projectHostSetupId ?? null,
      executionHostId: params.executionHostId
    }
    const admission = { type: 'createTerminalTab' as const, workspace, tabId, leafId, hostStamp }
    // Admitted before the owner creates, so this machine's membership holds the tab the window draws.
    const { result } = await startInAdmittedPane(
      this.store,
      params.groupId ? { ...admission, groupId: params.groupId } : admission,
      undefined,
      (outcome) => {
        if (outcome !== undefined && outcome !== 'admitted') {
          throw new Error(`terminal_host_admission_${outcome}`)
        }
        return hostCreate.forwardTerminalCreate(params, {
          resolveWorkspace: async () => source,
          transport,
          // The owner's handle and incarnation, bound to the admitted local pane.
          bind: async (created) =>
            (await this.store?.persistPtyBinding?.({
              worktreeId: workspace,
              tabId,
              leafId,
              ptyId: created.ptyId ?? '',
              ...(created.incarnationId ? { incarnationId: created.incarnationId } : {}),
              mayCreate: false,
              origin: 'spawn'
            })) ?? true
        })
      }
    )
    return result
  }
}
