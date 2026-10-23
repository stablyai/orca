import { openExternalLink } from '../platform/external-link'
import { Moon, Pin, PinOff } from 'lucide-react-native'
import { buildWorktreeNavigationActions } from '../agent-history/worktree-navigation-actions'
import { workspaceRouteHref } from '../navigation/workspace-execution-host'
import { useWorkspaceServer } from '../transport/workspace-server'
import { ActionSheetContent } from '../components/ActionSheetModal'
import { BottomDrawer } from '../components/BottomDrawer'
import { ConfirmContent, ConfirmModal } from '../components/ConfirmModal'
import { NewWorktreeModalController } from '../components/NewWorktreeModalController'
import { hostNewWorktreeSessionRoute } from '../host-new-worktree-session-route'
import { isWorktreePinned, type Worktree } from '../worktree/workspace-list-sections'
import { WorkspaceOptionsSheet } from './workspace-options-sheet'
import { WorkspaceDetailsSheet } from './workspace-details-sheet'
import type { HostScreenController } from './use-host-screen-controller'

export function HostScreenOverlays({ controller }: { controller: HostScreenController }) {
  const {
    actions,
    catalog,
    client,
    connState,
    existingWorktreePaths,
    hostCapabilities,
    hostId,
    state
  } = controller
  const actionTarget = state.actionTarget
  const isFolder = actionTarget?.workspaceKind === 'folder-workspace'
  const closeActionSheet = () => {
    state.setConfirmDelete(null)
    state.setActionTarget(null)
  }
  // A server row's screens are offered by what that server supports, not the desktop.
  const actionServer = useWorkspaceServer({
    client,
    connState,
    desktopCapabilities: hostCapabilities,
    executionHost: actionTarget?.hostId
  })

  return (
    <>
      <WorkspaceOptionsSheet controller={controller} />

      {/* Workspace long-press sheet: details and actions, with the delete confirm inline (no second Modal). */}
      <BottomDrawer visible={actionTarget != null} onClose={closeActionSheet}>
        {state.confirmDelete ? (
          <ConfirmContent
            title="Delete workspace"
            message={deleteConsequence(state.confirmDelete)}
            confirmLabel="Delete"
            destructive
            dismissOnConfirm={false}
            onConfirm={() => {
              if (state.confirmDelete) {
                void actions.handleDeleteWorktree(state.confirmDelete)
              }
              closeActionSheet()
            }}
            onCancel={() => state.setConfirmDelete(null)}
          />
        ) : (
          <ActionSheetContent
            onClose={closeActionSheet}
            actions={
              actionTarget
                ? [
                    ...buildWorktreeNavigationActions({
                      hostId,
                      worktreeId: actionTarget.worktreeId,
                      worktreeName: actionTarget.displayName || actionTarget.repo,
                      executionHost: actionServer.routeHost,
                      hostCapabilities:
                        actionServer.server?.gates.hostCapabilities ?? hostCapabilities,
                      navigate: actions.navigateFromHostList,
                      onDone: () => state.setActionTarget(null)
                    })
                      // A folder workspace has no repository for Source Control to read.
                      .filter((action) => !isFolder || action.label !== 'Source Control'),
                    // Server sleep is not offered yet; the desktop would sleep its own id.
                    ...(actionServer.server
                      ? []
                      : [
                          {
                            label: 'Sleep',
                            icon: Moon,
                            onPress: () => {
                              actions.putWorktreeToSleep(actionTarget)
                              state.setActionTarget(null)
                            }
                          }
                        ]),
                    {
                      label: isWorktreePinned(actionTarget, state.pinnedIds) ? 'Unpin' : 'Pin',
                      icon: isWorktreePinned(actionTarget, state.pinnedIds) ? PinOff : Pin,
                      onPress: () => {
                        actions.togglePin(actionTarget)
                        state.setActionTarget(null)
                      }
                    },
                    {
                      label: 'Delete',
                      destructive: true,
                      // The sheet stays up and turns into the confirm.
                      skipAutoClose: true,
                      onPress: () => state.setConfirmDelete(actionTarget)
                    }
                  ]
                : []
            }
          >
            {actionTarget ? (
              <WorkspaceDetailsSheet
                row={actionTarget}
                onOpenLink={(url) => {
                  openExternalLink(url)
                  state.setActionTarget(null)
                }}
              />
            ) : null}
          </ActionSheetContent>
        )}
      </BottomDrawer>

      {/* Host remove confirmation */}
      <ConfirmModal
        visible={state.confirmRemoveHost}
        title="Remove desktop"
        message={`Remove \u201c${state.hostName}\u201d from this phone? You can pair it again later.`}
        confirmLabel="Remove"
        destructive
        onConfirm={() => void actions.handleRemoveHost()}
        onCancel={() => state.setConfirmRemoveHost(false)}
      />

      <NewWorktreeModalController
        visible={state.showNewWorktree}
        client={client}
        hostCapabilities={hostCapabilities}
        hostId={hostId}
        hostLabelById={state.hostLabelById}
        existingWorktreePaths={existingWorktreePaths}
        existingWorktrees={state.worktrees}
        // The seam, not react-native's `Linking`: this screen is in the tasks page closure, and
        // inside the shell's WebView `openURL` resolves without opening anything.
        openExternalUrl={openExternalLink}
        onCreated={(worktreeId, worktreeName, warning, executionHost) => {
          void catalog.fetchWorktrees({ allowDuringModal: true })
          actions.navigateFromHostList(
            workspaceRouteHref(
              hostNewWorktreeSessionRoute(hostId, worktreeId, worktreeName, warning),
              executionHost
            )
          )
        }}
        onClose={actions.closeNewWorktreeModal}
      />
    </>
  )
}

// The desktop's delete dialog copy (`delete-worktree-dialog-copy.ts`). The phone sends `force`, so
// the change-loss line is always said rather than only for a dirty workspace.
function deleteConsequence(row: Worktree): string {
  const name = `\u201c${row.displayName || row.repo}\u201d`
  if (row.workspaceKind === 'folder-workspace') {
    return `Remove ${name} from Orca. The project folder on disk will not be deleted.`
  }
  return `Remove ${name} from git and delete its workspace folder. Any uncommitted or untracked changes will be permanently deleted.`
}
