import { useCallback, useMemo, useState } from 'react'
import { computeActiveTerminalKeyboardLift } from '../terminal/terminal-keyboard-avoidance-lift'
import {
  terminalPaneDirection,
  terminalPaneKeyboardLayout
} from '../terminal/session/mobile-terminal-pane-layout'
import { Animated, View, Text, Pressable, ActivityIndicator } from 'react-native'
import { saveTerminalTextScale } from '../storage/preferences'
import { MobileBrowserPane } from '../browser/MobileBrowserPane'
import { TerminalPaneView } from '../terminal/session/TerminalPaneView'
import { MobileNativeChatOverlay } from './native-chat/MobileNativeChatOverlay'
import { mobileSessionNativeChatHostOutage } from './native-chat/mobile-native-chat-host-outage'
import { MobileAgentMessageProvider } from './native-chat/transcript/MobileAgentMessageProvider'
import { MobileNativeChatForkProvider } from './MobileNativeChatForkProvider'
import { useMobileAgentMessageNavigation } from './use-mobile-agent-message-navigation'
import { MobileNativeChatDictationPreviewContext } from './native-chat/composer/mobile-native-chat-dictation-preview-context'
import { resolveMobileNativeChatSessionId } from './native-chat/mobile-native-chat-eligibility'
import { colors } from '../theme/mobile-theme'
import { useMobileColorScheme } from '../theme/use-mobile-color-scheme'
import { useMobileTranslation } from '../i18n/use-mobile-translation'
import { styles } from './mobile-session-styles'
import type { MobileSessionController } from './use-mobile-session-controller'
import { useMobileSessionContentKeyboardLift } from '../terminal/session/use-mobile-session-keyboard-lift'
import { useOpenUrlInOrca } from '../browser/use-open-url-in-orca'
import { useWorkspaceExecutionHost } from '../navigation/workspace-execution-host'
import { useOpenHostAccounts } from '../accounts/use-open-mobile-accounts'
import { useHostProfile } from '../transport/hosts/use-host-profile'
import { useHostDisplay } from '../transport/hosts/use-host-display'
import { FileReader } from '../files/session-documents/MobileSessionFileReader'
import { MobileSessionContentState } from './MobileSessionContentState'
import { MarkdownReader } from '../files/session-documents/MobileSessionMarkdownReader'
import { markdownTabDraftKey } from '../drafts/document-edit-draft-rows'
import { loadMarkdownPreviewImage } from '../files/mobile-markdown-image-source'

export function MobileSessionActiveContent({
  controller
}: {
  controller: MobileSessionController
}) {
  useMobileColorScheme()
  const t = useMobileTranslation()
  const executionHost = useWorkspaceExecutionHost()
  const [paneFrame, setPaneFrame] = useState({ width: 0, height: 0 })
  const paneDirection = terminalPaneDirection(paneFrame, controller.terminalSplitLayout)
  const {
    hostId,
    worktreeId,
    client,
    terminals,
    terminalTextScale,
    setTerminalTextScale,
    terminalTextScaleRevisionRef,
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
    handleTerminalWebReady,
    notifyTerminalFrame,
    notifyTerminalCellBoxChange,
    handleFileTap,
    handleNativeChatFileTap,
    handleTerminalOpenUrl,
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
    showEmptyState,
    createTabBusy
  } = controller
  const { keyboardLift, activeTerminalKeyboardLift, toastAnimatedStyle } =
    useMobileSessionContentKeyboardLift(controller)
  const openUrlInOrca = useOpenUrlInOrca(controller)
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
  const toast = toastMessage ? (
    <Animated.View pointerEvents="none" style={[styles.toast, toastAnimatedStyle]}>
      <Text style={styles.toastText}>{toastMessage}</Text>
    </Animated.View>
  ) : null
  const content =
    showLoadingState || showEmptyState || showOfflineState ? (
      <MobileSessionContentState
        connState={presentedConnState}
        hostName={hostTitle}
        lastTabs={controller.visibleTabs.length > 0 ? { hostId, worktreeId } : null}
        loading={showLoadingState}
        creating={createTabBusy}
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
          diffCommentActions={
            activeFileTab.diffSource === 'staged' || activeFileTab.diffSource === 'unstaged'
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
        <MobileBrowserPane
          key={activeBrowserTab.browserPageId ?? activeBrowserTab.id}
          client={client}
          worktreeId={worktreeId}
          tab={activeBrowserTab}
          screencastSupported={browserScreencastSupported}
          keyboardLift={keyboardLift}
          bottomInset={controller.insets.bottom}
          onToast={showToast}
        />
        {toast}
      </View>
    ) : activePendingTerminalTab ? (
      <View style={styles.emptyState}>
        {!isPendingTerminalRecoveryParked && (
          <ActivityIndicator size="small" color={colors.textSecondary} />
        )}
        <Text style={styles.emptyText}>
          {isPendingTerminalRecoveryParked
            ? t(
                'session.activeContent.terminalTakingLonger',
                'Terminal is taking longer than expected'
              )
            : activePendingTerminalTab.title ||
              t('session.activeContent.loadingTerminal', 'Loading terminal')}
        </Text>
        {isPendingTerminalRecoveryParked && (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={t(
              'session.activeContent.retryLoadingTerminal',
              'Retry loading terminal'
            )}
            style={({ pressed }) => [
              styles.createButton,
              pressed && styles.newTerminalButtonPressed
            ]}
            onPress={() => void retryPendingTerminalRecovery()}
          >
            <Text style={styles.createButtonText}>{t('common.retry', 'Retry')}</Text>
          </Pressable>
        )}
      </View>
    ) : (
      <View style={styles.terminalFrame}>
        {terminals.map((terminal) => (
          <TerminalPaneView
            key={terminal.handle}
            handle={terminal.handle}
            active={terminal.handle === activeHandle}
            visible={
              visibleTerminalHandles?.includes(terminal.handle) ?? terminal.handle === activeHandle
            }
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
                        controller.getTerminalPaneViewport(terminal.handle).terminalFrameRef.current
                          ?.height ?? 0
                    })
                  : activeTerminalKeyboardLift
            }
            terminalTheme={terminal.terminalTheme}
            textScale={terminalTextScale}
            onTextScaleChange={(scale) => {
              // Why: pinch-to-zoom reports a new preset; persist it so the size sticks across panes and launches.
              terminalTextScaleRevisionRef.current += 1
              setTerminalTextScale(scale)
              void saveTerminalTextScale(scale)
            }}
            onRef={setTerminalWebViewRef}
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
            onOpenUrl={handleTerminalOpenUrl}
          />
        ))}
        <MobileNativeChatDictationPreviewContext.Provider value={chatDictationPreview}>
          <MobileAgentMessageProvider
            key={JSON.stringify([hostId, executionHost, worktreeId])}
            tabs={controller.sessionTabs}
            terminals={controller.terminals}
            scopeKey={nativeChatImageSource}
            open={openSender}
          >
            <MobileNativeChatForkProvider controller={controller}>
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
                hostOutage={nativeChatHostOutage}
                onRunInTerminal={(command) =>
                  void controller.handleCreateTerminal(undefined, {
                    startupCommand: command,
                    startupCommandDelivery: 'shell-ready',
                    terminalView: true
                  })
                }
                // Accounts open on the paired host, so a chat another server runs offers none.
                onOpenAccounts={executionHost === undefined ? openNativeChatAccounts : undefined}
              />
            </MobileNativeChatForkProvider>
          </MobileAgentMessageProvider>
        </MobileNativeChatDictationPreviewContext.Provider>
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
