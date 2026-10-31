import { Platform } from 'react-native'
import { useMobileTranslation } from '../i18n/use-mobile-translation'
import { getRepoIdFromWorktreeId } from '../../../src/shared/worktree/id'
import { useClipboardWriter } from '../platform/clipboard'
import { Copy, FileText, Globe, RefreshCw, SquareTerminal } from 'lucide-react-native'
import { MobileSessionTerminalLayoutSheet } from './MobileSessionTerminalLayoutSheet'
import { QuickCommandsSheet } from './QuickCommandsSheet'
import { triggerSuccess, triggerError } from '../platform/haptics'
import { ActionSheetModal } from '../components/ActionSheetModal'
import { TextInputModal } from '../components/TextInputModal'
import { MobileTerminalRenameModal } from './MobileTerminalRenameModal'
import { ConfirmModal } from '../components/ConfirmModal'
import { CustomKeyModal } from '../components/CustomKeyModal'
import { MobileDictationSetupSheet } from '../components/MobileDictationSetupSheet'
import { useWorkspaceOnPairedHost } from '../navigation/workspace-execution-host'
import { MobileBrowserTabActionSheet } from './MobileBrowserTabActionSheet'
import { getMobileTerminalActionSheetActions } from './mobile-terminal-action-sheet-actions'
import { isTerminalPhoneDisplayMode } from './mobile-session-route-helpers'
import type { MobileSessionController } from './use-mobile-session-controller'
import { useMobileAllowAutoCloseActions } from './mobile-worker-auto-close'
import { MobileAgentSessionTabActionSheet } from './MobileAgentSessionTabActionSheet'

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
    setBrowserActionTarget,
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
    leaveSession,
    discardMarkdownLocalContent,
    copyMarkdownPath,
    confirmDiscardMarkdown,
    handleDeleteCustomKey,
    handleManageShortcuts,
    handleClearTerminal,
    handleCreateTerminal,
    launchQuickCommand,
    handleCreateMarkdownNote,
    handleCreateBrowser,
    handleBrowserNavigationCommand,
    handleCloseTerminal,
    handleCloseSessionTab,
    bulkCloseActions,
    bulkCloseConfirm,
    closeWithBulkActions,
    createTabAgentActions,
    sendDiffNotesAgentActions
  } = controller
  const clipboard = useClipboardWriter()
  const onPairedHost = useWorkspaceOnPairedHost()
  return (
    <>
      <MobileSessionTerminalLayoutSheet
        controller={controller}
        visible={showTerminalLayout}
        onClose={() => setShowTerminalLayout(false)}
      />
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
      <ActionSheetModal
        visible={showCreateTabDrawer}
        title={t('session.sheets.newTab', 'New Tab')}
        actions={[
          ...createTabAgentActions,
          {
            id: 'terminal',
            label: t('session.sheets.terminal', 'Terminal'),
            icon: SquareTerminal,
            onPress: () => {
              setShowCreateTabDrawer(false)
              void handleCreateTerminal()
            }
          },
          // Why: browser/markdown creation resolve a real worktree on the host
          // (browser.tabCreate, files.createFile); the floating sentinel is
          // terminal-only over RPC, so those options hide there.
          ...(isFloatingWorkspaceRoute
            ? []
            : [
                {
                  id: 'browser',
                  label: t('session.sheets.browser', 'Browser'),
                  icon: Globe,
                  closeBeforePress: true,
                  onPress: () => {
                    if (browserScreencastSupported !== true) {
                      showToast(
                        t(
                          'session.sheets.browserUpdateRequired',
                          'Desktop update required for mobile browser streaming'
                        ),
                        1600
                      )
                      return
                    }
                    setShowCreateBrowserModal(true)
                  }
                },
                ...(onPairedHost
                  ? [
                      {
                        id: 'markdownNote',
                        label: t('session.sheets.markdownNote', 'Markdown Note'),
                        icon: FileText,
                        onPress: () => {
                          setShowCreateTabDrawer(false)
                          void handleCreateMarkdownNote()
                        }
                      }
                    ]
                  : [])
              ])
        ]}
        onClose={() => setShowCreateTabDrawer(false)}
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
      <ActionSheetModal
        visible={fileActionTarget != null}
        title={fileActionTarget?.title || t('session.sheets.file', 'File')}
        actions={[
          {
            id: 'refresh',
            label: t('common.refresh', 'Refresh'),
            icon: RefreshCw,
            onPress: () => {
              const target = fileActionTarget
              setFileActionTarget(null)
              if (target) {
                void readFileTab(target)
              }
            }
          },
          ...closeWithBulkActions(fileActionTarget, () => setFileActionTarget(null))
        ]}
        onClose={() => setFileActionTarget(null)}
      />
      <MobileBrowserTabActionSheet
        target={browserActionTarget}
        onClose={() => setBrowserActionTarget(null)}
        onNavigate={handleBrowserNavigationCommand}
        onCloseTab={handleCloseSessionTab}
        bulkCloseActions={bulkCloseActions}
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
                  leaveSession()
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
              leaveSession()
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
        keyboardType={Platform.OS === 'ios' ? 'url' : 'default'}
        onSubmit={(value) => {
          void handleCreateBrowser(value).then((created) => {
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
