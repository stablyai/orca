import { Platform } from 'react-native'
import { Copy, FileText, Globe, RefreshCw, SquareTerminal } from 'lucide-react-native'
import { MobileSessionHeaderMoreActionsSheet } from './MobileSessionHeaderMoreActionsSheet'
import { QuickCommandsSheet } from './QuickCommandsSheet'
import { ActionSheetModal } from '../components/ActionSheetModal'
import { TextInputModal } from '../components/TextInputModal'
import { ConfirmModal } from '../components/ConfirmModal'
import { CustomKeyModal } from '../components/CustomKeyModal'
import { MobileDictationSetupSheet } from '../components/MobileDictationSetupSheet'
import { MobileBrowserTabActionSheet } from './MobileBrowserTabActionSheet'
import { getMobileTerminalActionSheetActions } from './mobile-terminal-action-sheet-actions'
import { isTerminalPhoneDisplayMode } from './mobile-session-route-helpers'
import type { MobileSessionController } from './use-mobile-session-controller'

export function MobileSessionSheets({ controller }: { controller: MobileSessionController }) {
  const {
    worktreeId,
    isFloatingWorkspaceRoute,
    client,
    worktreeName,
    sessionTabs,
    pendingDiffNotesDelivery,
    setPendingDiffNotesDelivery,
    showCreateTabDrawer,
    setShowCreateTabDrawer,
    setShowCreateBrowserModal,
    showCreateBrowserModal,
    showHeaderMoreActions,
    setShowHeaderMoreActions,
    actionTarget,
    setActionTarget,
    markdownActionTarget,
    setMarkdownActionTarget,
    fileActionTarget,
    setFileActionTarget,
    browserActionTarget,
    setBrowserActionTarget,
    agentSessionActionTarget,
    setAgentSessionActionTarget,
    discardMarkdownTarget,
    setDiscardMarkdownTarget,
    leaveDrafts,
    setLeaveDrafts,
    setRenameTarget,
    renameTarget,
    setCustomKeys,
    showCustomKeyModal,
    setShowCustomKeyModal,
    deleteKeyTarget,
    setDeleteKeyTarget,
    terminalModes,
    showDictationSetup,
    setShowDictationSetup,
    browserScreencastSupported,
    quickCommandsSupported,
    showToast,
    nativeChatTranscriptIsLocalReadable,
    nativeChatController,
    toggleTabChatView,
    toggleDisplayMode,
    readFileTab,
    leaveSession,
    discardMarkdownLocalContent,
    confirmDiscardMarkdown,
    handleDeleteCustomKey,
    handleManageShortcuts,
    handleClearTerminal,
    handleCreateTerminal,
    launchQuickCommand,
    handleCreateMarkdownNote,
    handleCreateBrowser,
    handleBrowserNavigationCommand,
    handleRenameTerminal,
    handleCloseTerminal,
    handleCloseSessionTab,
    bulkCloseActions,
    closeWithBulkActions,
    createTabAgentActions,
    sendDiffNotesAgentActions,
    handlePanelTap,
    openAgentSessionHistory,
    showAgentSessionHistoryAction,
    showChecksAction,
    copyTextToDevice,
    sessionDeviceOperations,
    sessionDictationOperations,
    sessionQuickCommandOperations,
    clearMarkdownDrafts,
    setQuickCommandsOpenFor,
    handleCustomKeyModalAfterClose,
    showQuickCommands,
    triggerError,
    triggerSuccess
  } = controller
  return (
    <>
      <MobileSessionHeaderMoreActionsSheet
        visible={showHeaderMoreActions}
        showAgentSessionHistory={showAgentSessionHistoryAction}
        showChecks={showChecksAction}
        onOpenAgentSessionHistory={openAgentSessionHistory}
        onOpenChecks={() => handlePanelTap('pr')}
        onClose={() => setShowHeaderMoreActions(false)}
      />
      <QuickCommandsSheet
        visible={showQuickCommands && quickCommandsSupported === true}
        onClose={() => setQuickCommandsOpenFor(null)}
        operations={sessionQuickCommandOperations}
        workspaceId={worktreeId}
        repoName={worktreeName || null}
        onLaunch={launchQuickCommand}
        onCopy={copyTextToDevice}
      />
      <ActionSheetModal
        visible={showCreateTabDrawer}
        title="New Tab"
        actions={[
          ...createTabAgentActions,
          {
            label: 'Terminal',
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
                  label: 'Browser',
                  closeBeforePress: true,
                  icon: Globe,
                  onPress: () => {
                    if (browserScreencastSupported !== true) {
                      showToast('Desktop update required for mobile browser streaming', 1600)
                      return
                    }
                    setShowCreateBrowserModal(true)
                  }
                },
                {
                  label: 'Markdown Note',
                  icon: FileText,
                  onPress: () => {
                    setShowCreateTabDrawer(false)
                    void handleCreateMarkdownNote()
                  }
                }
              ])
        ]}
        onClose={() => setShowCreateTabDrawer(false)}
      />
      <ActionSheetModal
        visible={pendingDiffNotesDelivery !== null}
        title="Send Review Notes"
        message="Choose an agent session for the current notes."
        actions={[
          ...sendDiffNotesAgentActions,
          {
            label: 'Copy Notes',
            icon: Copy,
            onPress: () => {
              const delivery = pendingDiffNotesDelivery
              setPendingDiffNotesDelivery(null)
              if (!delivery) {
                return
              }
              void copyTextToDevice(delivery.prompt)
                .then(() => {
                  triggerSuccess()
                  showToast('Notes copied')
                })
                .catch(() => {
                  triggerError()
                  showToast("Couldn't copy notes", 1500)
                })
            }
          }
        ]}
        onClose={() => setPendingDiffNotesDelivery(null)}
      />
      <ActionSheetModal
        visible={actionTarget != null}
        title={actionTarget?.title || 'Terminal'}
        actions={getMobileTerminalActionSheetActions({
          target: actionTarget,
          tabs: sessionTabs.filter((tab) => tab.type === 'terminal'),
          isTabChatView: nativeChatController.isTabChatView,
          nativeChatTranscriptIsLocalReadable,
          onDismiss: () => setActionTarget(null),
          onToggleChat: toggleTabChatView,
          isPhoneMode: (handle) => isTerminalPhoneDisplayMode(handle, terminalModes),
          onToggleDisplayMode: (handle) => void toggleDisplayMode(handle),
          onRename: setRenameTarget,
          onClear: (target) => void handleClearTerminal(target),
          onClose: (target) => void handleCloseTerminal(target),
          onCloseSessionTab: (tab) => void handleCloseSessionTab(tab),
          bulkCloseActions
        })}
        onClose={() => setActionTarget(null)}
      />
      <ActionSheetModal
        visible={markdownActionTarget != null}
        title={markdownActionTarget?.title || 'Markdown'}
        actions={[
          {
            label: 'Refresh',
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
            label: 'Copy Path',
            icon: FileText,
            onPress: () => {
              const target = markdownActionTarget
              setMarkdownActionTarget(null)
              if (target) {
                void copyTextToDevice(target.relativePath || target.filePath)
                  .then(() => showToast('Path copied'))
                  .catch(() => showToast("Couldn't copy path", 1500))
              }
            }
          },
          ...closeWithBulkActions(markdownActionTarget, () => setMarkdownActionTarget(null))
        ]}
        onClose={() => setMarkdownActionTarget(null)}
      />
      <ActionSheetModal
        visible={fileActionTarget != null}
        title={fileActionTarget?.title || 'File'}
        actions={[
          {
            label: 'Refresh',
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
      <ActionSheetModal
        visible={agentSessionActionTarget != null}
        title={agentSessionActionTarget?.title || 'Chat'}
        actions={closeWithBulkActions(agentSessionActionTarget, () =>
          setAgentSessionActionTarget(null)
        )}
        onClose={() => setAgentSessionActionTarget(null)}
      />
      <ActionSheetModal
        visible={leaveDrafts != null}
        title="Unsaved markdown changes"
        message="Copy or discard phone drafts before leaving."
        actions={[
          {
            label: 'Copy All & Leave',
            icon: FileText,
            onPress: () => {
              const drafts = leaveDrafts ?? []
              const combined = drafts
                .map((draft) => `# ${draft.title}\n\n${draft.content}`)
                .join('\n\n---\n\n')
              void copyTextToDevice(combined)
                .then(() => {
                  return clearMarkdownDrafts(drafts.map((draft) => draft.tabId)).catch(() => {})
                })
                .then(() => {
                  setLeaveDrafts(null)
                  leaveSession()
                })
                .catch(() => {
                  triggerError()
                  showToast("Couldn't copy drafts", 1500)
                })
            }
          },
          {
            label: 'Discard & Leave',
            destructive: true,
            onPress: () => {
              const drafts = leaveDrafts ?? []
              void clearMarkdownDrafts(drafts.map((draft) => draft.tabId))
                .catch(() => {})
                .then(() => {
                  setLeaveDrafts(null)
                  leaveSession()
                })
            }
          }
        ]}
        onClose={() => setLeaveDrafts(null)}
      />
      <ConfirmModal
        visible={discardMarkdownTarget != null}
        title="Discard Changes"
        message="Replace the phone draft with the latest desktop file?"
        confirmLabel="Discard"
        destructive
        onConfirm={confirmDiscardMarkdown}
        onCancel={() => setDiscardMarkdownTarget(null)}
      />
      <TextInputModal
        visible={renameTarget != null}
        title="Rename Terminal"
        defaultValue={renameTarget?.title || 'Terminal'}
        placeholder="Terminal name"
        onSubmit={(value) => void handleRenameTerminal(value)}
        onCancel={() => setRenameTarget(null)}
      />
      <TextInputModal
        visible={showCreateBrowserModal}
        title="New Browser"
        message="Enter a URL, or leave blank for a new tab."
        defaultValue=""
        placeholder="https://example.com"
        submitLabel="Open"
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
        onAfterClose={handleCustomKeyModalAfterClose}
        onKeysChanged={setCustomKeys}
        onManageShortcuts={handleManageShortcuts}
        loadKeys={async () =>
          (await sessionDeviceOperations?.loadTerminalAccessoryPreferences())?.customKeys ?? []
        }
        saveKeys={async (keys) => {
          await sessionDeviceOperations?.saveTerminalCustomKeys(keys)
        }}
      />
      <MobileDictationSetupSheet
        visible={showDictationSetup}
        client={client}
        operations={sessionDictationOperations}
        onClose={() => setShowDictationSetup(false)}
        onReady={() => setShowDictationSetup(false)}
        onErrorFeedback={triggerError}
        onSuccessFeedback={triggerSuccess}
      />
      <ActionSheetModal
        visible={deleteKeyTarget != null}
        title={deleteKeyTarget?.label ?? 'Shortcut'}
        message="Remove this custom shortcut?"
        actions={[
          {
            label: 'Remove',
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
