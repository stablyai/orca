import { Platform } from 'react-native'
import { useClipboardWriter } from '../platform/clipboard'
import { Copy, FileText, Globe, RefreshCw, SquareTerminal } from 'lucide-react-native'
import { MobileSessionHeaderMoreActionsSheet } from './MobileSessionHeaderMoreActionsSheet'
import { QuickCommandsSheet } from './QuickCommandsSheet'
import { triggerSuccess, triggerError } from '../platform/haptics'
import { ActionSheetModal } from '../components/ActionSheetModal'
import { TextInputModal } from '../components/TextInputModal'
import { ConfirmModal } from '../components/ConfirmModal'
import { CustomKeyModal } from '../components/CustomKeyModal'
import { MobileDictationSetupSheet } from '../components/MobileDictationSetupSheet'
import { useWorkspaceOnPairedHost } from '../navigation/workspace-execution-host'
import { MobileBrowserTabActionSheet } from './MobileBrowserTabActionSheet'
import { getMobileTerminalActionSheetActions } from './mobile-terminal-action-sheet-actions'
import { getMobileNativeChatCliForkActions } from './mobile-native-chat-cli-fork'
import {
  getRepoIdFromMobileWorktreeId,
  isTerminalPhoneDisplayMode
} from './mobile-session-route-helpers'
import { describeBulkCloseConfirmation } from './mobile-bulk-close-sheet-actions'
import type { MobileSessionController } from './use-mobile-session-controller'

export function MobileSessionSheets({ controller }: { controller: MobileSessionController }) {
  const {
    worktreeId,
    isFolderWorkspaceRoute,
    isFloatingWorkspaceRoute,
    client,
    worktreeName,
    sessionTabs,
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
    terminalModes,
    browserScreencastSupported,
    quickCommandsSupported,
    quickCommandAgentPromptMaxLength,
    showToast,
    nativeChatTranscriptIsLocalReadable,
    nativeChatController,
    toggleTabChatView,
    toggleDisplayMode,
    readFileTab,
    leaveSession,
    discardMarkdownLocalContent,
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
    openAgentSessionHistory
  } = controller
  const clipboard = useClipboardWriter()
  const onPairedHost = useWorkspaceOnPairedHost()
  return (
    <>
      <MobileSessionHeaderMoreActionsSheet
        visible={controller.showHeaderMoreActions}
        showAgentSessionHistory={controller.showAgentSessionHistoryAction}
        showChecks={controller.showChecksAction}
        onOpenAgentSessionHistory={openAgentSessionHistory}
        onOpenChecks={() => handlePanelTap('pr')}
        onClose={() => controller.setShowHeaderMoreActions(false)}
      />
      <QuickCommandsSheet
        visible={controller.showQuickCommands && quickCommandsSupported === true}
        onClose={() => controller.setShowQuickCommands(false)}
        client={client}
        repoId={
          isFolderWorkspaceRoute || isFloatingWorkspaceRoute
            ? null
            : getRepoIdFromMobileWorktreeId(worktreeId) || null
        }
        repoName={worktreeName || null}
        agentPromptMaxLength={quickCommandAgentPromptMaxLength}
        onLaunch={launchQuickCommand}
      />
      <ActionSheetModal
        visible={controller.showCreateTabDrawer}
        title="New Tab"
        actions={[
          ...createTabAgentActions,
          {
            label: 'Terminal',
            icon: SquareTerminal,
            onPress: () => {
              controller.setShowCreateTabDrawer(false)
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
                  icon: Globe,
                  closeBeforePress: true,
                  onPress: () => {
                    if (browserScreencastSupported !== true) {
                      showToast('Desktop update required for mobile browser streaming', 1600)
                      return
                    }
                    controller.setShowCreateBrowserModal(true)
                  }
                },
                ...(onPairedHost
                  ? [
                      {
                        label: 'Markdown Note',
                        icon: FileText,
                        onPress: () => {
                          controller.setShowCreateTabDrawer(false)
                          void handleCreateMarkdownNote()
                        }
                      }
                    ]
                  : [])
              ])
        ]}
        onClose={() => controller.setShowCreateTabDrawer(false)}
      />
      <ActionSheetModal
        visible={controller.pendingDiffNotesDelivery !== null}
        title="Send Review Notes"
        message="Choose an agent session for the current notes."
        actions={[
          ...sendDiffNotesAgentActions,
          {
            label: 'Copy Notes',
            icon: Copy,
            onPress: () => {
              const delivery = controller.pendingDiffNotesDelivery
              controller.setPendingDiffNotesDelivery(null)
              if (!delivery) {
                return
              }
              void clipboard
                .writeText(delivery.prompt)
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
        onClose={() => controller.setPendingDiffNotesDelivery(null)}
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
          onRename: controller.setRenameTarget,
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
                void controller.copyMarkdownPath(target)
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
        actions={[
          ...getMobileNativeChatCliForkActions({
            controller,
            tab: agentSessionActionTarget,
            workspaceOnPairedHost: onPairedHost,
            onDismiss: () => setAgentSessionActionTarget(null)
          }),
          ...closeWithBulkActions(agentSessionActionTarget, () => setAgentSessionActionTarget(null))
        ]}
        onClose={() => setAgentSessionActionTarget(null)}
      />
      <ActionSheetModal
        visible={controller.leaveDrafts != null}
        title="Unsaved markdown changes"
        message="Copy or discard phone drafts before leaving."
        actions={[
          {
            label: 'Copy All & Leave',
            icon: FileText,
            onPress: () => {
              const drafts = controller.leaveDrafts ?? []
              const combined = drafts
                .map((draft) => `# ${draft.title}\n\n${draft.content}`)
                .join('\n\n---\n\n')
              void clipboard
                .writeText(combined)
                .then(() => {
                  controller.setLeaveDrafts(null)
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
              controller.setLeaveDrafts(null)
              leaveSession()
            }
          }
        ]}
        onClose={() => controller.setLeaveDrafts(null)}
      />
      <ConfirmModal
        visible={controller.discardMarkdownTarget != null}
        title="Discard Changes"
        message="Replace the phone draft with the latest desktop file?"
        confirmLabel="Discard"
        destructive
        onConfirm={controller.confirmDiscardMarkdown}
        onCancel={() => controller.setDiscardMarkdownTarget(null)}
      />
      <ConfirmModal
        visible={controller.pendingBulkClose != null}
        {...describeBulkCloseConfirmation(controller.pendingBulkClose)}
        destructive
        onConfirm={controller.confirmBulkClose}
        onCancel={controller.cancelBulkClose}
      />
      <TextInputModal
        visible={controller.renameTarget != null}
        title="Rename Terminal"
        defaultValue={controller.renameTarget?.title || 'Terminal'}
        placeholder="Terminal name"
        onSubmit={(value) => void handleRenameTerminal(value)}
        onCancel={() => controller.setRenameTarget(null)}
      />
      <TextInputModal
        visible={controller.showCreateBrowserModal}
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
              controller.setShowCreateBrowserModal(false)
            }
          })
        }}
        onCancel={() => controller.setShowCreateBrowserModal(false)}
      />
      <CustomKeyModal
        visible={controller.showCustomKeyModal}
        onClose={() => controller.setShowCustomKeyModal(false)}
        onKeysChanged={controller.setCustomKeys}
        onManageShortcuts={controller.handleManageShortcuts}
      />
      <MobileDictationSetupSheet
        visible={controller.showDictationSetup}
        client={client}
        onClose={() => controller.setShowDictationSetup(false)}
        onReady={() => controller.setShowDictationSetup(false)}
      />
      <ActionSheetModal
        visible={controller.deleteKeyTarget != null}
        title={controller.deleteKeyTarget?.label ?? 'Shortcut'}
        message="Remove this custom shortcut?"
        actions={[
          {
            label: 'Remove',
            destructive: true,
            onPress: () => {
              if (controller.deleteKeyTarget) {
                void controller.handleDeleteCustomKey(controller.deleteKeyTarget)
              }
              controller.setDeleteKeyTarget(null)
            }
          }
        ]}
        onClose={() => controller.setDeleteKeyTarget(null)}
      />
    </>
  )
}

