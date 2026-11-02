import { openExternalLink } from '../platform/external-link'
import { Pressable, Text, View } from 'react-native'
import { Moon, Pin, PinOff } from 'lucide-react-native'
import { buildWorktreeNavigationActions } from '../agent-history/worktree-navigation-actions'
import { workspaceRouteHref } from '../navigation/workspace-execution-host'
import { useWorkspaceServer } from '../transport/workspace-server'
import { ActionSheetContent } from '../components/ActionSheetModal'
import { BottomDrawer } from '../components/BottomDrawer'
import { ConfirmModal } from '../components/ConfirmModal'
import { NewWorktreeModalController } from '../components/NewWorktreeModalController'
import { hostNewWorktreeSessionRoute } from '../host-route-action-state'
import { isWorktreePinned } from '../worktree/workspace-list-sections'
import { hostScreenStyles as styles } from './host-screen-styles'
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
    showNewWorktree,
    state
  } = controller
  const actionTarget = state.actionTarget
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

      {/* Worktree long-press action sheet (inline confirm to avoid double-Modal lag) */}
      <BottomDrawer
        visible={actionTarget != null}
        onClose={() => {
          state.setConfirmDelete(null)
          state.setActionTarget(null)
        }}
      >
        {state.confirmDelete ? (
          <View>
            <View style={styles.confirmContent}>
              <Text style={styles.confirmTitle}>Delete Worktree</Text>
              <Text style={styles.confirmMessage}>
                Delete "{state.confirmDelete.displayName || state.confirmDelete.repo}" (
                {state.confirmDelete.branch})?
              </Text>
            </View>
            <View style={styles.confirmButtons}>
              <Pressable
                style={({ pressed }) => [
                  styles.confirmBtn,
                  styles.confirmBtnCancel,
                  pressed && styles.confirmBtnPressed
                ]}
                onPress={() => state.setConfirmDelete(null)}
              >
                <Text style={styles.confirmBtnCancelText}>Cancel</Text>
              </Pressable>
              <Pressable
                style={({ pressed }) => [
                  styles.confirmBtn,
                  styles.confirmBtnDestructive,
                  pressed && styles.confirmBtnPressed
                ]}
                onPress={() => {
                  if (state.confirmDelete) {
                    void actions.handleDeleteWorktree(state.confirmDelete)
                  }
                  state.setConfirmDelete(null)
                  state.setActionTarget(null)
                }}
              >
                <Text style={styles.confirmBtnDestructiveText}>Delete</Text>
              </Pressable>
            </View>
          </View>
        ) : (
          <ActionSheetContent
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
                    }),
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
        title="Remove Host"
        message={`Remove "${state.hostName}"? You can re-pair later.`}
        confirmLabel="Remove"
        destructive
        onConfirm={() => void actions.handleRemoveHost()}
        onCancel={() => state.setConfirmRemoveHost(false)}
      />

      <NewWorktreeModalController
        ref={state.newWorktreeModalRef}
        routeVisible={showNewWorktree}
        client={client}
        hostCapabilities={hostCapabilities}
        hostId={hostId}
        hostLabelById={state.hostLabelById}
        existingWorktreePaths={existingWorktreePaths}
        existingWorktrees={state.worktrees}
        // The seam, not react-native's `Linking`: this screen is in the tasks page closure, and
        // inside the shell's WebView `openURL` resolves without opening anything.
        openExternalUrl={openExternalLink}
        onVisibleChange={(visible) => {
          state.newWorktreeModalVisibleRef.current = visible
        }}
        onCreated={(worktreeId, worktreeName, warning, executionHost) => {
          void catalog.fetchWorktrees({ allowDuringModal: true })
          actions.navigateFromHostList(
            workspaceRouteHref(
              hostNewWorktreeSessionRoute(hostId, worktreeId, worktreeName, warning),
              executionHost
            )
          )
        }}
        onRouteVisibleChange={actions.setShowNewWorktreeVisible}
      />
    </>
  )
}
