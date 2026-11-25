import { MobileSessionBotIdentity } from './native-chat/MobileSessionBotIdentity'
import { MobileBotCardHostProvider } from './native-chat/transcript/bot-cards/MobileBotCardHostProvider'
import { nativeChatTerminalRunner } from './native-chat/native-chat-terminal-runner'
import { useCallback, useMemo, useState } from 'react'
import { computeActiveTerminalKeyboardLift } from '../terminal/keyboard/terminal-keyboard-avoidance-lift'
import {
  terminalPaneDirection,
  terminalPaneKeyboardLayout
} from '../terminal/session/pane-layout/mobile-terminal-pane-layout'
import { useWindowDimensions, View } from 'react-native'
import { CircleAlert } from 'lucide-react-native'
import { MobileBrowserTabBody } from '../browser/MobileBrowserTabBody'
import { TerminalPaneView } from '../terminal/session/pane-layout/TerminalPaneView'
import { MountedTerminalPanes } from '../terminal/session/pane-layout/mounted-terminal-lru'
import { MobileNativeChatOverlay } from './native-chat/MobileNativeChatOverlay'
import { mobileSessionNativeChatHostOutage } from './native-chat/status/mobile-native-chat-host-outage'
import { MobileAgentMessageProvider } from './native-chat/transcript/agent-messages/MobileAgentMessageProvider'
import { MobileNativeChatForkProvider } from './MobileNativeChatForkProvider'
import { useMobileAgentMessageNavigation } from './use-mobile-agent-message-navigation'
import { MobileNativeChatDictationPreviewContext } from './native-chat/composer/dictation/mobile-native-chat-dictation-preview-context'
import { resolveMobileNativeChatSessionId } from './native-chat/conversation/mobile-native-chat-eligibility'
import { useMobileColorScheme } from '../theme/use-mobile-color-scheme'
import { useMobileTranslation } from '../i18n/use-mobile-translation'
import { styles } from './mobile-session-styles'
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
  useMobileColorScheme()
  const t = useMobileTranslation()
  const executionHost = useWorkspaceExecutionHost()
  const [paneFrame, setPaneFrame] = useState({ width: 0, height: 0 })
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
    terminalTextScale,
    commitPinchedTextScale,
    terminalFontStyle,
    activeHandle,
    terminalSplitActive,
    visibleTerminalHandles,
    notifyTerminalPaneFrame,
    diffComments,
    diffCommentBusy,
    createError,
    setCreateError,
    setShowCreateTabDrawer,
    dictationMode,
    dictationEnabled,
    toastMessage,
    handleTerminalInteraction,
    handleTerminalTap,
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
    copyMarkdownPath,
    discardMarkdownLocalContent,
    saveMarkdownTab,
    setTerminalWebViewRef,
    releaseTerminalDocument,
    handleTerminalWebReady,
    notifyTerminalFrame,
    notifyTerminalCellBoxChange,
    handleFileTap,
    handleNativeChatFileTap,
    handleTerminalInput,
    handleTerminalQueryReply,
    handleSelectionMode,
    handleSelectionCopy,
    handleSelectionEvicted,
    handleClipboardWrite,
    handleModesChanged,
    handleKeyboardAvoidanceMetrics,
    handleHaptic,
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
  const nativeChatHostOutage = mobileSessionNativeChatHostOutage(controller, hostTitle, t)
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
        onCreateTab={() => {
          setCreateError('')
          setShowCreateTabDrawer(true)
        }}
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
          onCopyPath={() => void copyMarkdownPath(activeMarkdownTab)}
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
        <MountedTerminalPanes terminals={terminals} visibleHandles={visibleTerminalHandles}>
          {(terminal) => (
            <TerminalPaneView
              key={terminal.handle}
              handle={terminal.handle}
              active={terminal.handle === activeHandle}
              visible={visibleTerminalHandles.includes(terminal.handle)}
              splitIndex={
                terminalSplitActive && visibleTerminalHandles.includes(terminal.handle)
                  ? visibleTerminalHandles.indexOf(terminal.handle)
                  : undefined
              }
              splitDirection={paneDirection}
              splitFrame={paneFrame}
              keyboardInset={keyboardLift}
              title={terminal.title}
              onFrame={notifyTerminalPaneFrame}
              keyboardLift={
                terminal.handle !== activeHandle &&
                !(terminalSplitActive && visibleTerminalHandles.includes(terminal.handle))
                  ? 0
                  : terminalSplitActive
                    ? computeActiveTerminalKeyboardLift({
                        keyboardLift: terminalPaneKeyboardLayout(
                          paneFrame,
                          paneDirection,
                          visibleTerminalHandles.indexOf(terminal.handle),
                          keyboardLift
                        ).occlusion,
                        metrics: controller.terminalKeyboardMetrics.get(terminal.handle),
                        terminalFrameHeight:
                          controller.getTerminalPaneViewport(terminal.handle).terminalFrameRef
                            .current?.height ?? 0
                      })
                    : activeTerminalKeyboardLift
              }
              terminalTheme={terminal.terminalTheme}
              hostSettings={controller.terminalHostSettings}
              textScale={terminalTextScale}
              fontStyle={terminalFontStyle}
              onTextScaleChange={commitPinchedTextScale}
              onRef={setTerminalWebViewRef}
              onDocumentReleased={releaseTerminalDocument}
              onWebReady={handleTerminalWebReady}
              onCellBoxChange={notifyTerminalCellBoxChange}
              onSelectionMode={handleSelectionMode}
              onSelectionCopy={handleSelectionCopy}
              onSelectionEvicted={handleSelectionEvicted}
              onClipboardWrite={handleClipboardWrite}
              onModesChanged={handleModesChanged}
              onKeyboardAvoidanceMetrics={handleKeyboardAvoidanceMetrics}
              onHaptic={handleHaptic}
              onTerminalInput={handleTerminalInput}
              onTerminalQueryReply={handleTerminalQueryReply}
              onTerminalInteraction={handleTerminalInteraction}
              onTerminalTap={handleTerminalTap}
              onFileTap={handleFileTap}
              onOpenUrl={terminalLinks.handleTerminalOpenUrl}
            />
          )}
        </MountedTerminalPanes>
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
        const { width, height } = e.nativeEvent.layout
        notifyTerminalFrame({ width, height })
        setPaneFrame((previous) =>
          previous.width === width && previous.height === height ? previous : { width, height }
        )
      }}
    >
      {content}
    </View>
  )
}
