import { openExternalLink } from '../platform/external-link'
import { Pressable, Text, View } from 'react-native'
import { Moon, Pin, PinOff } from 'lucide-react-native'
import { buildWorktreeNavigationActions } from '../agent-history/worktree-navigation-actions'
import { workspaceRouteHref } from '../navigation/workspace-execution-host'
import { useWorkspaceServer } from '../transport/workspace-server'
import { ActionSheetContent } from '../components/ActionSheetModal'
import { BottomDrawer } from '../components/BottomDrawer'
import { AddProjectSheet } from '../add-project/AddProjectSheet'
import { ConfirmModal } from '../components/ConfirmModal'
import { NewWorktreeModalController } from '../components/NewWorktreeModalController'
import { hostNewWorktreeSessionRoute } from '../host-new-worktree-session-route'
import { isWorktreePinned } from '../worktree/workspace-list-sections'
import { useMobileColorScheme } from '../theme/use-mobile-color-scheme'
import { hostScreenStyles as styles } from './host-screen-styles'
import { WorkspaceOptionsSheet } from './workspace-options-sheet'
import { WorkspaceDetailsSheet } from './workspace-details-sheet'
import type { HostScreenController } from './use-host-screen-controller'
import { useMobileTranslation } from '../i18n/use-mobile-translation'

export function HostScreenOverlays({ controller }: { controller: HostScreenController }) {
  const t = useMobileTranslation()
  useMobileColorScheme()
  const {
    actions,
    catalog,
    client,
    connState,
    existingWorktreePaths,
    hostCapabilities,
    hostId,
    refreshAfterProjectAdded,
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

      {/* Confirm inline to avoid stacking native Modals. */}
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
              <Text style={styles.confirmTitle}>
                {t('hostScreen.hostScreenOverlays.deleteWorktree', 'Delete Worktree')}
              </Text>
              <Text style={styles.confirmMessage}>
                {t(
                  'hostScreen.hostScreenOverlays.deleteConfirmMessage',
                  'Delete "{{name}}" ({{branch}})?',
                  {
                    name: state.confirmDelete.displayName || state.confirmDelete.repo,
                    branch: state.confirmDelete.branch
                  }
                )}
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
                <Text style={styles.confirmBtnCancelText}>{t('common.cancel', 'Cancel')}</Text>
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
                <Text style={styles.confirmBtnDestructiveText}>{t('common.delete', 'Delete')}</Text>
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
                            id: 'sleep',
                            label: t('hostScreen.hostScreenOverlays.sleep', 'Sleep'),
                            icon: Moon,
                            onPress: () => {
                              actions.putWorktreeToSleep(actionTarget)
                              state.setActionTarget(null)
                            }
                          }
                        ]),
                    {
                      id: 'togglePin',
                      label: isWorktreePinned(actionTarget, state.pinnedIds)
                        ? t('hostScreen.hostScreenOverlays.unpin', 'Unpin')
                        : t('hostScreen.hostScreenOverlays.pin', 'Pin'),
                      icon: isWorktreePinned(actionTarget, state.pinnedIds) ? PinOff : Pin,
                      onPress: () => {
                        actions.togglePin(actionTarget)
                        state.setActionTarget(null)
                      }
                    },
                    {
                      id: 'delete',
                      label: t('common.delete', 'Delete'),
                      destructive: true,
                      onPress: () => state.setConfirmDelete(actionTarget),
                      // Like desktop, git can't remove a primary checkout; older hosts omit the flag.
                      ...(actionTarget.isMainWorktree === true
                        ? {
                            disabled: true,
                            hint: t(
                              'hostScreen.hostScreenOverlays.primaryWorktreeDeleteHint',
                              "Primary worktree — can't be deleted. Remove the project instead."
                            )
                          }
                        : {})
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

      <ConfirmModal
        visible={state.confirmRemoveHost}
        title={t('hostScreen.hostScreenOverlays.removeHost', 'Remove Host')}
        message={t(
          'hostScreen.hostScreenOverlays.removeHostMessage',
          'Remove "{{name}}"? You can re-pair later.',
          { name: state.hostName }
        )}
        confirmLabel={t('common.remove', 'Remove')}
        destructive
        onConfirm={() => void actions.handleRemoveHost()}
        onCancel={() => state.setConfirmRemoveHost(false)}
      />

      <AddProjectSheet
        visible={state.showAddProject}
        client={client}
        onClose={actions.closeAddProject}
        onNewWorkspace={actions.openNewWorktreeForRepo}
        onProjectAdded={refreshAfterProjectAdded}
      />

      <NewWorktreeModalController
        visible={state.showNewWorktree}
        initialRepoId={state.newWorktreeInitialRepoId}
        client={client}
        hostCapabilities={hostCapabilities}
        hostId={hostId}
        hostLabelById={state.hostLabelById}
        existingWorktreePaths={existingWorktreePaths}
        existingWorktrees={state.worktrees}
        // Use the platform opener: React Native Linking.openURL resolves without opening anything inside the shell’s WebView.
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
