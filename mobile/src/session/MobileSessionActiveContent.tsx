import { MobileSessionBotIdentity } from './native-chat/MobileSessionBotIdentity'
import { MobileBotCardHostProvider } from './native-chat/transcript/bot-cards/MobileBotCardHostProvider'
import { nativeChatTerminalRunner } from './native-chat/native-chat-terminal-runner'
import { useCallback, useMemo, useState } from 'react'
import { terminalPaneDirection } from '../terminal/session/pane-layout/mobile-terminal-pane-layout'
import { SessionTerminalPane } from './session-terminal-pane'
import { useWindowDimensions, View, StyleSheet } from 'react-native'
import { CircleAlert } from 'lucide-react-native'
import {
  sideStripMargin,
  sideStripOffset,
  useSessionSideStripInset
} from './session-side-strip-inset'
import { MobileBrowserTabBody } from '../browser/MobileBrowserTabBody'
import { MountedTerminalPanes } from '../terminal/session/pane-layout/mounted-terminal-lru'
import { MobileNativeChatOverlay } from './native-chat/MobileNativeChatOverlay'
import { useMobileSessionNativeChatHostOutage } from './native-chat/status/mobile-native-chat-host-outage'
import { MobileAgentMessageProvider } from './native-chat/transcript/agent-messages/MobileAgentMessageProvider'
import { MobileNativeChatForkProvider } from './MobileNativeChatForkProvider'
import { useMobileAgentMessageNavigation } from './use-mobile-agent-message-navigation'
import { MobileNativeChatDictationPreviewContext } from './native-chat/composer/dictation/mobile-native-chat-dictation-preview-context'
import { resolveMobileNativeChatSessionId } from './native-chat/conversation/mobile-native-chat-eligibility'
import { useThemedStyles } from '../theme/themed-styles'
import { useMobileTranslation } from '../i18n/use-mobile-translation'
import { stylesSheet } from './mobile-session-styles'
import { renderAnimatedToast } from '../components/feedback/TransientToast'
import type { MobileSessionController } from './use-mobile-session-controller'
import { useMobileSessionContentKeyboardLift } from '../terminal/session/input-controls/use-mobile-session-keyboard-lift'
import { useOpenUrlInOrca } from '../browser/tab-navigation/use-open-url-in-orca'
import { useMobileTerminalLinkOpen } from '../terminal/session/links/use-mobile-terminal-link-open'
import { useWorkspaceExecutionHost } from '../navigation/workspace-execution-host'
import { useOpenHostAccounts } from '../accounts/use-open-mobile-accounts'
import { useHostProfile } from '../host-catalog/use-host-profile'
import { useHostDisplay } from '../host-descriptors/use-host-display'
import { FileReader } from '../files/session-documents/MobileSessionFileReader'
import { MobileSessionContentState } from './MobileSessionContentState'
import { MobileStateView } from '../components/feedback/MobileStateView'
import { MarkdownReader } from '../files/session-documents/MobileSessionMarkdownReader'
import { markdownTabDraftKey } from '../drafts/document-edit-draft-rows'
import { workspaceDraftRowKey } from '../drafts/durable-draft-rows'
import { loadMarkdownPreviewImage } from '../files/markdown/mobile-markdown-image-source'

export function MobileSessionActiveContent({
  controller
}: {
  controller: MobileSessionController
}) {
  const styles = useThemedStyles(stylesSheet)
  const t = useMobileTranslation()
  const executionHost = useWorkspaceExecutionHost()
  const [paneFrame, setPaneFrame] = useState({ width: 0, height: 0 })
  const { main: stripInset } = useSessionSideStripInset(
    controller.canDockPanel && controller.activePanel !== null
  )
  const windowWidth = useWindowDimensions().width
  const paneDirection = terminalPaneDirection(
    paneFrame,
    controller.terminalSplitLayout,
    windowWidth
  )
  const {
    hostId,
    worktreeId,
    client,
    terminals,
    activeHandle,
    terminalSplitActive,
    visibleTerminalHandles,
    diffComments,
    diffCommentBusy,
    createError,
    dictationMode,
    dictationEnabled,
    toastMessage,
    browserScreencastSupported,
    showToast,
    nativeChatSendError,
    nativeChatOverlayInputLockReason,
    nativeChatController,
    dictation,
    chatDictationPreview,
    handleDictationToggle,
    handleDictationPressIn,
    handleDictationPressOut,
    readMarkdownTab,
    addDiffCommentForFile,
    deleteDiffCommentForFile,
    copyDiffCommentsToClipboard,
    sendDiffCommentsToAgent,
    sendingDiffCommentIds,
    updateMarkdownLocalContent,
    copyMarkdownText,
    discardMarkdownLocalContent,
    saveMarkdownTab,
    notifyTerminalFrame,
    handleNativeChatFileTap,
    nativeChatImages,
    nativeChatStructuredComposer,
    activeMarkdownTab,
    activeFileTab,
    activeBrowserTab,
    activePendingTerminalTab,
    isPendingTerminalRecoveryParked,
    retryPendingTerminalRecovery,
    showLoadingState,
    showEmptyState
  } = controller
  const { keyboardLift, activeTerminalKeyboardLift, toastAnimatedStyle } =
    useMobileSessionContentKeyboardLift(controller)
  const openUrlInOrca = useOpenUrlInOrca(controller)
  const terminalLinks = useMobileTerminalLinkOpen(controller, openUrlInOrca)
  const hostProfile = useHostProfile(hostId)
  const hostTitle = useHostDisplay(hostProfile).title
  const nativeChatHostOutage = useMobileSessionNativeChatHostOutage(controller, hostTitle, t)
  const nativeChatImageSource = useMemo(
    () => (client ? { client, worktreeId } : undefined),
    [client, worktreeId]
  )
  const openNativeChatAccounts = useOpenHostAccounts(controller.router, hostId)
  const navigateToSender = useCallback(
    (senderWorktreeId: string, paneKey: string) => {
      const execution = executionHost ? `&executionHost=${encodeURIComponent(executionHost)}` : ''
      controller.router.push(
        `/h/${encodeURIComponent(hostId)}/session/${encodeURIComponent(senderWorktreeId)}?paneKey=${encodeURIComponent(paneKey)}${execution}`
      )
    },
    [controller.router, hostId, executionHost]
  )
  const openSender = useMobileAgentMessageNavigation(
    client,
    navigateToSender,
    JSON.stringify([hostId, executionHost, worktreeId, controller.activeSessionTab?.id]),
    controller.showToast,
    controller
  )
  const { presentedConnState, showOfflineState, forceReconnectHost } = controller
  const terminalBranch = !(
    showLoadingState ||
    showEmptyState ||
    showOfflineState ||
    activeMarkdownTab ||
    activeFileTab ||
    activeBrowserTab ||
    activePendingTerminalTab
  )
  // Review notes are for working-tree diffs only.
  const fileTabTakesNotes =
    activeFileTab?.diffSource === 'staged' || activeFileTab?.diffSource === 'unstaged'
  const toast = renderAnimatedToast(toastMessage, toastAnimatedStyle)
  const content =
    showLoadingState || showEmptyState || showOfflineState ? (
      <MobileSessionContentState
        connState={presentedConnState}
        hostName={hostTitle}
        lastTabs={controller.visibleTabs.length > 0 ? { hostId, worktreeId } : null}
        loading={showLoadingState}
        creating={controller.createTabBusy}
        createError={createError}
        onReconnect={forceReconnectHost ? () => void forceReconnectHost(hostId) : null}
        onRetryTabs={() => void retryPendingTerminalRecovery()}
        onNewTab={controller.handleOpenNewTab}
      />
    ) : activeMarkdownTab ? (
      <View style={styles.markdownFrame}>
        <MarkdownReader
          documentId={activeMarkdownTab.id}
          draftKey={markdownTabDraftKey(
            { hostId, executionHost, worktreeId },
            activeMarkdownTab.id
          )}
          doc={controller.markdownDocs.get(activeMarkdownTab.id)}
          onRefresh={() => void readMarkdownTab(activeMarkdownTab)}
          onChange={(content) => updateMarkdownLocalContent(activeMarkdownTab.id, content)}
          onSave={() => void saveMarkdownTab(activeMarkdownTab)}
          onCopy={(text) => void copyMarkdownText(text)}
          onDiscard={() => discardMarkdownLocalContent(activeMarkdownTab)}
          loadImageSource={(path) =>
            loadMarkdownPreviewImage(client, worktreeId, activeMarkdownTab.relativePath, path)
          }
          keyboardLift={keyboardLift}
        />
        {toast}
      </View>
    ) : activeFileTab ? (
      <View style={styles.markdownFrame}>
        <FileReader
          documentId={JSON.stringify([hostId, executionHost, worktreeId, activeFileTab.id])}
          client={client}
          doc={controller.fileDocs.get(activeFileTab.id)}
          title={activeFileTab.title || t('session.activeContent.fileTitle', 'File')}
          relativePath={activeFileTab.relativePath}
          language={activeFileTab.language}
          noteDraftKey={
            fileTabTakesNotes
              ? workspaceDraftRowKey(
                  'fileNote',
                  { hostId, executionHost, worktreeId },
                  activeFileTab.relativePath
                )
              : undefined
          }
          diffCommentActions={
            fileTabTakesNotes
              ? {
                  comments: diffComments,
                  sendingCommentIds: sendingDiffCommentIds,
                  busy: diffCommentBusy,
                  onAdd: addDiffCommentForFile,
                  onDelete: deleteDiffCommentForFile,
                  onCopyAll: copyDiffCommentsToClipboard,
                  onSendAll: sendDiffCommentsToAgent
                }
              : undefined
          }
        />
        {toast}
      </View>
    ) : activeBrowserTab ? (
      <View style={styles.browserFrame}>
        {/* Why: pane owns imperative frame refs; don't render a stale frame while the old stream effect cleans up. */}
        <MobileBrowserTabBody
          key={activeBrowserTab.browserPageId ?? activeBrowserTab.id}
          client={client}
          worktreeId={worktreeId}
          tab={activeBrowserTab}
          screencastSupported={browserScreencastSupported}
          hostSupport={controller.browserHostSupport}
          keyboardLift={keyboardLift}
          bottomInset={controller.insets.bottom}
          onToast={showToast}
        />
        {toast}
      </View>
    ) : activePendingTerminalTab ? (
      isPendingTerminalRecoveryParked ? (
        <MobileStateView
          icon={CircleAlert}
          title={t(
            'session.activeContent.terminalTakingLonger',
            'Terminal is taking longer than expected'
          )}
          action={{
            label: t('common.retry', 'Retry'),
            onPress: () => void retryPendingTerminalRecovery()
          }}
        />
      ) : (
        <MobileStateView
          loading
          title={
            activePendingTerminalTab.title ||
            t('session.activeContent.loadingTerminal', 'Loading terminal')
          }
        />
      )
    ) : (
      <View style={styles.terminalFrame}>
        <View style={[StyleSheet.absoluteFill, sideStripOffset(stripInset)]}>
          <MountedTerminalPanes terminals={terminals} visibleHandles={visibleTerminalHandles}>
            {(terminal) => (
              <SessionTerminalPane
                key={terminal.handle}
                terminal={terminal}
                controller={controller}
                activeHandle={activeHandle}
                terminalSplitActive={terminalSplitActive}
                visibleTerminalHandles={visibleTerminalHandles}
                paneFrame={paneFrame}
                paneDirection={paneDirection}
                keyboardLift={keyboardLift}
                activeTerminalKeyboardLift={activeTerminalKeyboardLift}
                onOpenUrl={terminalLinks.handleTerminalOpenUrl}
              />
            )}
          </MountedTerminalPanes>
        </View>
        <MobileNativeChatDictationPreviewContext.Provider value={chatDictationPreview}>
          <MobileAgentMessageProvider
            key={JSON.stringify([hostId, executionHost, worktreeId])}
            tabs={controller.sessionTabs}
            terminals={controller.terminals}
            scopeKey={nativeChatImageSource}
            open={openSender}
          >
            <MobileNativeChatForkProvider controller={controller}>
              <MobileBotCardHostProvider {...{ client, hostId, executionHost, hostTitle }}>
                <MobileSessionBotIdentity controller={controller}>
                  <MobileNativeChatOverlay
                    controller={nativeChatController}
                    imageSource={nativeChatImageSource}
                    worktreePath={controller.worktreePath}
                    connState={controller.connState}
                    activeSessionTabId={controller.activeSessionTab?.id}
                    onOpenFile={handleNativeChatFileTap}
                    images={nativeChatImages}
                    structuredComposer={nativeChatStructuredComposer}
                    onMicPress={dictationEnabled ? handleDictationToggle : undefined}
                    micActive={dictation.isStarting || dictation.isRecording}
                    micStarting={dictation.isStarting}
                    micProcessing={dictation.isProcessing}
                    dictationMode={dictationMode}
                    onMicPressIn={handleDictationPressIn}
                    onMicPressOut={handleDictationPressOut}
                    inputLockReason={nativeChatOverlayInputLockReason}
                    sendErrorMessage={nativeChatSendError.message}
                    onClearSendError={nativeChatSendError.clear}
                    sendSurfaceId={controller.nativeChatScopeKey ?? ''}
                    sessionId={resolveMobileNativeChatSessionId(controller.activeSessionTab)}
                    getSendCompletionGeneration={controller.getSendCompletionGeneration}
                    keyboardInset={keyboardLift}
                    // A workspace routed to another server stops with that server, whose name the phone lacks.
                    hostName={executionHost === undefined && hostProfile ? hostTitle : null}
                    onOpenUrlInOrca={openUrlInOrca}
                    linkOpenMode={controller.linkOpenMode}
                    hostOutage={nativeChatHostOutage}
                    onRunInTerminal={nativeChatTerminalRunner(controller)}
                    // Accounts open on the paired host, so a chat another server runs offers none.
                    onOpenAccounts={
                      executionHost === undefined ? openNativeChatAccounts : undefined
                    }
                  />
                </MobileSessionBotIdentity>
              </MobileBotCardHostProvider>
            </MobileNativeChatForkProvider>
          </MobileAgentMessageProvider>
        </MobileNativeChatDictationPreviewContext.Provider>
        {terminalLinks.terminalLinkSheet}
        {toast}
      </View>
    )
  return (
    <View
      // Why: one frame under every branch; react-native-web observes onLayout only on a View that mounts with it.
      style={styles.contentFrame}
      onLayout={(e) => {
        const { height } = e.nativeEvent.layout
        const width = e.nativeEvent.layout.width - (stripInset?.width ?? 0)
        notifyTerminalFrame({ width, height })
        setPaneFrame((previous) =>
          previous.width === width && previous.height === height ? previous : { width, height }
        )
      }}
    >
      {terminalBranch ? (
        content
      ) : (
        <View style={[styles.contentFrame, sideStripMargin(stripInset)]}>{content}</View>
      )}
    </View>
  )
}
