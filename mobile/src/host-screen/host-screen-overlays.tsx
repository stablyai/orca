import { useState } from 'react'
import { openExternalLink } from '../platform/external-links/external-link'
import { workspaceRouteHref } from '../navigation/workspace-execution-host'
import { useWorkspaceServer } from '../worktree/execution-hosts/workspace-server'
import { ActionSheetContent } from '../components/sheets/ActionSheetModal'
import { BottomDrawer } from '../components/bottom-drawer/BottomDrawer'
import { BottomDrawerModalHost } from '../components/bottom-drawer/bottom-drawer-modal-host'
import { ConfirmModal } from '../components/sheets/ConfirmModal'
import { OrcaHookTrustDrawer } from '../components/hook-trust/OrcaHookTrustDrawer'
import { NewWorktreeModalController } from '../new-workspace/creation/modal/NewWorktreeModalController'
import { hostNewWorktreeSessionRoute } from '../host-new-worktree-session-route'
import type { Worktree } from '../worktree/workspace-list/workspace-list-types'
import { useMobileColorScheme } from '../theme/use-mobile-color-scheme'
import { WorkspaceOptionsSheet } from './workspace-options/workspace-options-sheet'
import { HostNewBotSheet } from './host-new-bot-sheet'
import { WorkspaceDetailsSheet } from './workspace-actions/workspace-details-sheet'
import { WorkspaceRenameSheet } from './workspace-actions/workspace-rename-sheet'
import { WorkspaceStatusSheet } from './workspace-actions/workspace-status-sheet'
import { WorkspaceDeleteConfirmSheet } from './workspace-actions/workspace-delete-confirm-sheet'
import { useWorkspaceRowMenuActions } from './workspace-actions/use-workspace-row-menu-actions'
import { useWorkspaceHandToBot } from './workspace-actions/use-workspace-hand-to-bot'
import { useBottomDrawerFollowUp } from '../components/bottom-drawer/use-bottom-drawer-follow-up'
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
    hostDisplay,
    hostId,
    state
  } = controller
  const actionTarget = state.actionTarget
  // Tied to the menu's row, so a menu closed elsewhere never reopens on the rename sheet.
  const [renameTarget, setRenameTarget] = useState<Worktree | null>(null)
  const [statusTarget, setStatusTarget] = useState<Worktree | null>(null)
  const handToBot = useWorkspaceHandToBot({
    controller,
    closeMenuThen: (then) => menuFollowUp.closeThen(then)
  })
  const closeActionSheet = () => {
    setRenameTarget(null)
    setStatusTarget(null)
    handToBot.reset()
    state.setConfirmDelete(null)
    state.setActionTarget(null)
  }
  const menuFollowUp = useBottomDrawerFollowUp(closeActionSheet)
  // A server row's screens are offered by what that server supports, not the desktop.
  const actionServer = useWorkspaceServer({
    client,
    connState,
    desktopCapabilities: hostCapabilities,
    executionHost: actionTarget?.hostId
  })
  const rowMenuActions = useWorkspaceRowMenuActions({
    controller,
    row: actionTarget,
    server: actionServer,
    onRename: setRenameTarget,
    onMoveToStatus: setStatusTarget,
    onHandToBot: handToBot.open
  })

  return (
    <>
      <WorkspaceOptionsSheet controller={controller} />
      <HostNewBotSheet controller={controller} />
      {handToBot.newBotSheet}

      {/* iOS cannot present over a closing sibling Modal; delete's confirm, trust prompt and failure share one. */}
      <BottomDrawerModalHost>
        <BottomDrawer
          visible={actionTarget != null}
          dismissible={!handToBot.busy}
          {...menuFollowUp.drawerProps}
        >
          {state.confirmDelete ? (
            <WorkspaceDeleteConfirmSheet
              row={state.confirmDelete}
              hostId={hostId ?? ''}
              rowClient={
                actionServer.routeHost === undefined
                  ? client
                  : (actionServer.server?.client ?? null)
              }
              routeHost={actionServer.routeHost ?? undefined}
              onCancel={() => state.setConfirmDelete(null)}
              onDelete={() => {
                if (state.confirmDelete) {
                  void actions.handleDeleteWorktree(state.confirmDelete)
                }
                state.setConfirmDelete(null)
                state.setActionTarget(null)
              }}
            />
          ) : actionTarget && renameTarget === actionTarget ? (
            <WorkspaceRenameSheet
              hostId={hostId ?? ''}
              hostName={hostDisplay.title}
              row={actionTarget}
              rename={actions.renameWorktree}
              blockedOffline={actions.workspaceRenameWrite.blockedOffline}
              onClose={closeActionSheet}
            />
          ) : actionTarget && statusTarget === actionTarget ? (
            <WorkspaceStatusSheet
              row={actionTarget}
              statuses={state.view.workspaceStatuses}
              onPick={actions.setWorktreeStatus}
              onClose={closeActionSheet}
            />
          ) : actionTarget && handToBot.target === actionTarget ? (
            handToBot.sheet(actionTarget, closeActionSheet)
          ) : (
            <ActionSheetContent actions={rowMenuActions}>
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

        <OrcaHookTrustDrawer
          visible={actions.archiveTrustRequest != null}
          prompt={actions.archiveTrustRequest?.prompt ?? null}
          onRunOnce={() => void actions.approveArchiveTrust(false)}
          onAlwaysTrust={() => void actions.approveArchiveTrust(true)}
          onDontRun={actions.skipArchiveHook}
          onClose={actions.cancelArchiveTrust}
        />

        <ConfirmModal
          visible={actions.archiveHookFailure != null}
          title={t('hostScreen.hostScreenOverlays.deleteFailed', 'Failed to delete "{{name}}"', {
            name:
              actions.archiveHookFailure?.item.displayName || actions.archiveHookFailure?.item.repo
          })}
          message={actions.archiveHookFailure?.message}
          confirmLabel={t('common.delete', 'Delete')}
          destructive
          onConfirm={actions.deleteDespiteArchiveHookFailure}
          onCancel={actions.dismissArchiveHookFailure}
        />

        <ConfirmModal
          visible={actions.deleteFailure != null}
          title={t('hostScreen.hostScreenOverlays.deleteFailed', 'Failed to delete "{{name}}"', {
            name: actions.deleteFailure?.item.displayName || actions.deleteFailure?.item.repo
          })}
          message={actions.deleteFailure?.message}
          confirmLabel={t('common.ok', 'OK')}
          cancelLabel={null}
          onConfirm={actions.dismissDeleteFailure}
          onCancel={actions.dismissDeleteFailure}
        />
      </BottomDrawerModalHost>

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

      <NewWorktreeModalController
        visible={state.showNewWorktree}
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
