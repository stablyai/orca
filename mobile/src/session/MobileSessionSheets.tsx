import { Platform } from 'react-native'
import { useMobileTranslation } from '../i18n/use-mobile-translation'
import { getRepoIdFromWorktreeId } from '../../../src/shared/worktree/id'
import { useClipboardWriter } from '../platform/clipboard/clipboard'
import { Copy, FileText, RefreshCw } from 'lucide-react-native'
import { MobileSessionTerminalLayoutSheet } from '../terminal/session/pane-layout/MobileSessionTerminalLayoutSheet'
import { QuickCommandsSheet } from '../terminal/quick-commands/QuickCommandsSheet'
import { triggerSuccess, triggerError } from '../platform/haptics/haptics'
import { ActionSheetModal } from '../components/sheets/ActionSheetModal'
import { TextInputModal } from '../components/sheets/TextInputModal'
import { MobileTerminalRenameModal } from '../terminal/session/tab-actions/MobileTerminalRenameModal'
import { ConfirmModal } from '../components/sheets/ConfirmModal'
import { CustomKeyModal } from '../terminal/shortcuts/settings/CustomKeyModal'
import { MobileDictationSetupSheet } from '../dictation/setup/MobileDictationSetupSheet'
import { useWorkspaceOnPairedHost } from '../navigation/workspace-execution-host'
import { MobileFileTabActionSheet } from './MobileFileTabActionSheet'
import { MobileSessionBrowserTabSheet } from './MobileSessionBrowserTabSheet'
import { getMobileTerminalActionSheetActions } from '../terminal/session/tab-actions/mobile-terminal-action-sheet-actions'
import { isTerminalPhoneDisplayMode } from '../terminal/session/pane-layout/terminal-phone-display-mode'
import type { MobileSessionController } from './use-mobile-session-controller'
import { useMobileAllowAutoCloseActions } from './tabs/mobile-worker-auto-close'
import { MobileAgentSessionTabActionSheet } from './tabs/MobileAgentSessionTabActionSheet'
import { MobileSessionBotSheet } from './MobileSessionBotSheet'
import { MobileNewTabSheet } from './tabs/MobileNewTabSheet'
import { MobileNewHomeChatConfirm } from './MobileNewHomeChatConfirm'
import {
  MobileBrowserProfilePicker,
  useMobileNewBrowserProfile
} from './tabs/MobileBrowserProfilePicker'
import { MobileSessionTextSizeSheet } from './MobileSessionTextSizeSheet'
import { useMobileWindowsShellChoices } from '../terminal/session/creation/mobile-windows-shell-choices'

export function MobileSessionSheets({ controller }: { controller: MobileSessionController }) {
  const t = useMobileTranslation()
  const terminalWorkerActions = useMobileAllowAutoCloseActions(
    controller.client,
    controller.actionTarget && { terminal: controller.actionTarget.handle }
  )
  const {
    worktreeId,
    isFolderWorkspaceRoute,
    isFloatingWorkspaceRoute,
    client,
    worktreeName,
    sessionTabs,
    pendingDiffNotesDelivery,
    setPendingDiffNotesDelivery,
    showCreateTabDrawer,
    setShowCreateTabDrawer,
    showQuickCommands,
    setShowQuickCommands,
    setShowCreateBrowserModal,
    showCreateBrowserModal,
    showTerminalLayout,
    setShowTerminalLayout,
    actionTarget,
    setActionTarget,
    markdownActionTarget,
    setMarkdownActionTarget,
    fileActionTarget,
    setFileActionTarget,
    browserActionTarget,
    discardMarkdownTarget,
    setDiscardMarkdownTarget,
    leaveDrafts,
    setLeaveDrafts,
    setRenameTarget,
    setCustomKeys,
    showCustomKeyModal,
    setShowCustomKeyModal,
    deleteKeyTarget,
    setDeleteKeyTarget,
    terminalModes,
    showDictationSetup,
    closeDictationSetup,
    browserScreencastSupported,
    quickCommandsSupported,
    showToast,
    nativeChatController,
    toggleTabChatView,
    toggleDisplayMode,
    readFileTab,
    leaveSessionDroppingDrafts,
    discardMarkdownLocalContent,
    copyMarkdownPath,
    confirmDiscardMarkdown,
    handleDeleteCustomKey,
    handleManageShortcuts,
    smartRailEnabled,
    handleSmartRailChange,
    handleClearTerminal,
    handleCreateTerminal,
    launchQuickCommand,
    handleCreateMarkdownNote,
    handleCreateBrowser,
    handleCloseTerminal,
    handleCloseSessionTab,
    bulkCloseActions,
    bulkCloseConfirm,
    closeWithBulkActions,
    createTabAgentStatusRow,
    createTabAgentOptions,
    createTabAgentSurfaceChoice,
    sendDiffNotesAgentActions
  } = controller
  const clipboard = useClipboardWriter()
  const onPairedHost = useWorkspaceOnPairedHost()
  // The host owns which shells it would start here, as desktop's menu does for its own projects.
  const terminalShells = useMobileWindowsShellChoices({
    client,
    sheetOpen: showCreateTabDrawer,
    worktreeId
  })
  const browserProfile = useMobileNewBrowserProfile(
    client,
    (showCreateTabDrawer && !isFloatingWorkspaceRoute && browserScreencastSupported === true) ||
      browserActionTarget != null
  )
  return (
    <>
      <MobileSessionBotSheet controller={controller} />
      <MobileSessionTerminalLayoutSheet
        controller={controller}
        visible={showTerminalLayout}
        onClose={() => setShowTerminalLayout(false)}
      />
      <MobileSessionTextSizeSheet controller={controller} />
      <QuickCommandsSheet
        visible={showQuickCommands && quickCommandsSupported === true}
        onClose={() => setShowQuickCommands(false)}
        client={client}
        repoId={
          isFolderWorkspaceRoute || isFloatingWorkspaceRoute
            ? null
            : getRepoIdFromWorktreeId(worktreeId) || null
        }
        repoName={worktreeName || null}
        agentPromptMaxLength={controller.quickCommandAgentPromptMaxLength}
        onLaunch={launchQuickCommand}
      />
      <MobileNewHomeChatConfirm controller={controller} />
      <MobileNewTabSheet
        visible={showCreateTabDrawer}
        workspaceName={worktreeName}
        agentOptions={createTabAgentOptions}
        surfaceChoice={createTabAgentSurfaceChoice}
        agentStatusRow={createTabAgentStatusRow}
        bot={controller.botNewTabActions}
        // Why: browser/markdown creation resolve a real worktree on the host
        // (browser.tabCreate, files.createFile); the floating sentinel is
        // terminal-only over RPC, so those options hide there.
        canCreateBrowser={!isFloatingWorkspaceRoute}
        browserProfileLabel={browserProfile.newTabLabel}
        onChooseBrowserProfile={() => browserProfile.setPickerOpen(true)}
        canCreateMarkdownNote={!isFloatingWorkspaceRoute && onPairedHost}
        onClose={() => setShowCreateTabDrawer(false)}
        onCreateAgent={(agent, nativeChatDefault) =>
          void handleCreateTerminal(agent, undefined, nativeChatDefault)
        }
        terminalShells={terminalShells}
        onCreateTerminal={(shell) =>
          void handleCreateTerminal(undefined, shell ? { shell } : undefined)
        }
        onCreateBrowser={() => {
          if (browserScreencastSupported !== true) {
            showToast(
              t(
                'session.sheets.browserStreamingUnavailable',
                "This host can't stream browser tabs"
              ),
              1600
            )
            return
          }
          setShowCreateBrowserModal(true)
        }}
        onCreateMarkdownNote={() => void handleCreateMarkdownNote()}
      />
      <ActionSheetModal
        visible={pendingDiffNotesDelivery !== null}
        title={t('session.sheets.sendReviewNotes', 'Send Review Notes')}
        message={t('session.sheets.notesHint', 'Choose an agent session for the current notes.')}
        actions={[
          ...sendDiffNotesAgentActions,
          {
            id: 'copyNotes',
            label: t('session.sheets.copyNotes', 'Copy Notes'),
            icon: Copy,
            onPress: () => {
              const delivery = pendingDiffNotesDelivery
              setPendingDiffNotesDelivery(null)
              if (!delivery) {
                return
              }
              void clipboard
                .writeText(delivery.prompt)
                .then(() => {
                  triggerSuccess()
                  showToast(t('session.sheets.notesCopied', 'Notes copied'))
                })
                .catch(() => {
                  triggerError()
                  showToast(t('session.sheets.copyNotesFailed', "Couldn't copy notes"), 1500)
                })
            }
          }
        ]}
        onClose={() => setPendingDiffNotesDelivery(null)}
      />
      <ActionSheetModal
        visible={actionTarget != null}
        title={actionTarget?.title || t('session.sheets.terminal', 'Terminal')}
        actions={getMobileTerminalActionSheetActions({
          target: actionTarget,
          tabs: sessionTabs.filter((tab) => tab.type === 'terminal'),
          isTabChatView: nativeChatController.isTabChatView,
          nativeChatTranscriptIsLocalReadable: controller.nativeChatTranscriptIsLocalReadable,
          onDismiss: () => setActionTarget(null),
          onToggleChat: toggleTabChatView,
          isPhoneMode: (handle) => isTerminalPhoneDisplayMode(handle, terminalModes),
          onToggleDisplayMode: (handle) => void toggleDisplayMode(handle),
          onRename: setRenameTarget,
          onClear: (target) => void handleClearTerminal(target),
          onClose: (target) => void handleCloseTerminal(target),
          onCloseSessionTab: (tab) => void handleCloseSessionTab(tab),
          bulkCloseActions,
          workerActions: terminalWorkerActions
        })}
        onClose={() => setActionTarget(null)}
      />
      <ActionSheetModal
        visible={markdownActionTarget != null}
        title={markdownActionTarget?.title || t('session.sheets.markdown', 'Markdown')}
        actions={[
          {
            id: 'refresh',
            label: t('common.refresh', 'Refresh'),
            icon: RefreshCw,
            // Why: dirty refresh opens ConfirmModal; wait for this sheet's native
            // Modal to unmount first (same dual-Modal race as tab Rename, #10331).
            closeBeforePress: true,
            onPress: () => {
              const target = markdownActionTarget
              if (target) {
                discardMarkdownLocalContent(target)
              }
            }
          },
          {
            id: 'copyPath',
            label: t('session.sheets.copyPath', 'Copy Path'),
            icon: FileText,
            onPress: () => {
              const target = markdownActionTarget
              setMarkdownActionTarget(null)
              if (target) {
                void copyMarkdownPath(target)
              }
            }
          },
          ...closeWithBulkActions(markdownActionTarget, () => setMarkdownActionTarget(null))
        ]}
        onClose={() => setMarkdownActionTarget(null)}
      />
      <MobileFileTabActionSheet
        target={fileActionTarget}
        onClose={() => setFileActionTarget(null)}
        onRefresh={(target) => void readFileTab(target)}
        onToast={showToast}
        closeWithBulkActions={closeWithBulkActions}
      />
      <MobileSessionBrowserTabSheet
        controller={controller}
        profileLabel={browserProfile.tabLabel(browserActionTarget?.browserProfileId)}
      />
      <MobileBrowserProfilePicker
        choice={browserProfile}
        // Back to the new-tab sheet, where the chosen profile now shows.
        onAfterClose={() => setShowCreateTabDrawer(true)}
      />
      <MobileAgentSessionTabActionSheet
        controller={controller}
        workspaceOnPairedHost={onPairedHost}
      />
      <ActionSheetModal
        visible={leaveDrafts != null}
        title={t('session.sheets.unsavedMarkdown', 'Unsaved markdown changes')}
        message={t('session.sheets.draftsHint', 'Copy or discard phone drafts before leaving.')}
        actions={[
          {
            id: 'copyAllAndLeave',
            label: t('session.sheets.copyAllAndLeave', 'Copy All & Leave'),
            icon: FileText,
            onPress: () => {
              const drafts = leaveDrafts ?? []
              const combined = drafts
                .map((draft) => `# ${draft.title}\n\n${draft.content}`)
                .join('\n\n---\n\n')
              void clipboard
                .writeText(combined)
                .then(() => {
                  setLeaveDrafts(null)
                  leaveSessionDroppingDrafts(drafts)
                })
                .catch(() => {
                  triggerError()
                  showToast(t('session.sheets.copyDraftsFailed', "Couldn't copy drafts"), 1500)
                })
            }
          },
          {
            id: 'discardAndLeave',
            label: t('session.sheets.discardAndLeave', 'Discard & Leave'),
            destructive: true,
            onPress: () => {
              setLeaveDrafts(null)
              leaveSessionDroppingDrafts(leaveDrafts ?? [])
            }
          }
        ]}
        onClose={() => setLeaveDrafts(null)}
      />
      <ConfirmModal
        visible={discardMarkdownTarget != null}
        title={t('session.sheets.discardChanges', 'Discard Changes')}
        message={t(
          'session.sheets.discardMessage',
          'Replace the phone draft with the latest desktop file?'
        )}
        confirmLabel={t('session.sheets.discard', 'Discard')}
        destructive
        onConfirm={confirmDiscardMarkdown}
        onCancel={() => setDiscardMarkdownTarget(null)}
      />
      <ConfirmModal {...bulkCloseConfirm} />
      <MobileTerminalRenameModal controller={controller} />
      <TextInputModal
        visible={showCreateBrowserModal}
        title={t('session.sheets.newBrowser', 'New Browser')}
        message={t('session.sheets.urlPrompt', 'Enter a URL, or leave blank for a new tab.')}
        defaultValue=""
        placeholder="https://example.com"
        submitLabel={t('common.open', 'Open')}
        allowEmpty
        selectTextOnFocus
        // The session page reports 'web', where RN Web maps 'url' to the URL keyboard.
        keyboardType={Platform.OS === 'android' ? 'default' : 'url'}
        onSubmit={(value) => {
          void handleCreateBrowser(value, browserProfile.profileId ?? undefined).then((created) => {
            if (created) {
              setShowCreateBrowserModal(false)
            }
          })
        }}
        onCancel={() => setShowCreateBrowserModal(false)}
      />
      <CustomKeyModal
        visible={showCustomKeyModal}
        onClose={() => setShowCustomKeyModal(false)}
        onKeysChanged={setCustomKeys}
        onManageShortcuts={handleManageShortcuts}
        smartRail={{ enabled: smartRailEnabled, onChange: handleSmartRailChange }}
      />
      <MobileDictationSetupSheet
        visible={showDictationSetup}
        client={client}
        onClose={closeDictationSetup}
        onReady={closeDictationSetup}
      />
      <ActionSheetModal
        visible={deleteKeyTarget != null}
        title={deleteKeyTarget?.label ?? t('session.sheets.shortcut', 'Shortcut')}
        message={t('session.sheets.removeShortcutMessage', 'Remove this custom shortcut?')}
        actions={[
          {
            id: 'remove',
            label: t('common.remove', 'Remove'),
            destructive: true,
            onPress: () => {
              if (deleteKeyTarget) {
                void handleDeleteCustomKey(deleteKeyTarget)
              }
              setDeleteKeyTarget(null)
            }
          }
        ]}
        onClose={() => setDeleteKeyTarget(null)}
      />
    </>
  )
}
