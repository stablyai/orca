import { Animated, View, Text } from 'react-native'
import { Hourglass, Layers } from 'lucide-react-native'
import { StateView } from '../components/ui/StateView'
import { MobileSessionOfflineState } from './MobileSessionOfflineState'
import { saveTerminalTextScale } from '../storage/preferences'
import { MobileBrowserPane } from '../browser/MobileBrowserPane'
import { TerminalPaneView } from './TerminalPaneView'
import { MobileNativeChatOverlay } from './MobileNativeChatOverlay'
import { resolveMobileNativeChatSessionId } from './mobile-native-chat-eligibility'
import { styles } from './mobile-session-styles'
import type { MobileSessionController } from './use-mobile-session-controller'
import { useWorkspaceExecutionHost } from '../navigation/workspace-execution-host'
import { FileReader } from './MobileSessionFileReader'
import { MarkdownReader } from './MobileSessionMarkdownReader'

export function MobileSessionActiveContent({
  controller
}: {
  controller: MobileSessionController
}) {
  const executionHost = useWorkspaceExecutionHost()
  const {
    hostId,
    worktreeId,
    insets,
    connState,
    client,
    terminals,
    terminalTextScale,
    setTerminalTextScale,
    terminalTextScaleRevisionRef,
    activeHandle,
    markdownDocs,
    fileDocs,
    diffComments,
    diffCommentBusy,
    createError,
    setCreateError,
    setShowCreateTabDrawer,
    dictationMode,
    dictationEnabled,
    toastMessage,
    handleTerminalTap,
    browserScreencastSupported,
    showToast,
    nativeChatSendError,
    nativeChatOverlayInputLockReason,
    nativeChatController,
    dictation,
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
    copyMarkdownLocalContent,
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
    visibleTabs,
    keyboardLift,
    activeTerminalKeyboardLift,
    toastAnimatedStyle,
    createTabBusy
  } = controller
  // Why: loading and empty both need a live connection; without one an empty session explains itself here.
  const showOfflineState = connState !== 'connected' && visibleTabs.length === 0 && !activeHandle
  const content = showLoadingState ? (
    <StateView loading title="Loading tabs…" />
  ) : showEmptyState ? (
    <StateView
      icon={Layers}
      title="No tabs open"
      message={createError || 'Start an agent, a terminal or a browser in this workspace.'}
      primary={{
        label: 'New tab',
        busy: createTabBusy,
        onPress: () => {
          setCreateError('')
          setShowCreateTabDrawer(true)
        }
      }}
      testID="session-empty-state"
    />
  ) : showOfflineState ? (
    <MobileSessionOfflineState controller={controller} />
  ) : activeMarkdownTab ? (
    <View style={styles.markdownFrame}>
      <MarkdownReader
        documentId={activeMarkdownTab.id}
        doc={markdownDocs.get(activeMarkdownTab.id)}
        onRefresh={() => void readMarkdownTab(activeMarkdownTab)}
        onChange={(content) => updateMarkdownLocalContent(activeMarkdownTab.id, content)}
        onSave={() => void saveMarkdownTab(activeMarkdownTab)}
        onCopy={() => void copyMarkdownLocalContent(activeMarkdownTab.id)}
        onDiscard={() => discardMarkdownLocalContent(activeMarkdownTab)}
        keyboardLift={keyboardLift}
      />
      {toastMessage && (
        <Animated.View pointerEvents="none" style={[styles.toast, toastAnimatedStyle]}>
          <Text style={styles.toastText}>{toastMessage}</Text>
        </Animated.View>
      )}
    </View>
  ) : activeFileTab ? (
    <View style={styles.markdownFrame}>
      <FileReader
        documentId={JSON.stringify([hostId, executionHost, worktreeId, activeFileTab.id])}
        client={client}
        doc={fileDocs.get(activeFileTab.id)}
        title={activeFileTab.title || 'File'}
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
      {toastMessage && (
        <Animated.View pointerEvents="none" style={[styles.toast, toastAnimatedStyle]}>
          <Text style={styles.toastText}>{toastMessage}</Text>
        </Animated.View>
      )}
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
        bottomInset={insets.bottom}
        onToast={showToast}
      />
      {toastMessage && (
        <Animated.View pointerEvents="none" style={[styles.toast, toastAnimatedStyle]}>
          <Text style={styles.toastText}>{toastMessage}</Text>
        </Animated.View>
      )}
    </View>
  ) : activePendingTerminalTab ? (
    isPendingTerminalRecoveryParked ? (
      <StateView
        icon={Hourglass}
        title="Terminal is taking longer than expected"
        message="Your desktop has not attached it yet."
        primary={{ label: 'Retry', onPress: () => void retryPendingTerminalRecovery() }}
      />
    ) : (
      <StateView loading title={activePendingTerminalTab.title || 'Starting terminal…'} />
    )
  ) : (
    <View style={styles.terminalFrame}>
      {terminals.map((terminal) => (
        <TerminalPaneView
          key={terminal.handle}
          handle={terminal.handle}
          active={terminal.handle === activeHandle}
          keyboardLift={terminal.handle === activeHandle ? activeTerminalKeyboardLift : 0}
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
          onTerminalTap={handleTerminalTap}
          onFileTap={handleFileTap}
          onOpenUrl={handleTerminalOpenUrl}
        />
      ))}
      <MobileNativeChatOverlay
        controller={nativeChatController}
        activeSessionTabId={controller.activeSessionTab?.id}
        onOpenFile={handleNativeChatFileTap}
        images={nativeChatImages}
        structuredComposer={nativeChatStructuredComposer}
        onMicPress={dictationEnabled ? handleDictationToggle : undefined}
        micActive={dictation.isRecording}
        micStatus={
          dictation.isProcessing
            ? 'processing'
            : dictation.isRecording
              ? 'recording'
              : dictation.isStarting
                ? 'starting'
                : 'idle'
        }
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
      />
      {toastMessage && (
        <Animated.View pointerEvents="none" style={[styles.toast, toastAnimatedStyle]}>
          <Text style={styles.toastText}>{toastMessage}</Text>
        </Animated.View>
      )}
    </View>
  )
  return (
    <View
      // Why: one frame under every branch; react-native-web observes onLayout only on a View that mounts with it.
      style={styles.contentFrame}
      onLayout={(e) => {
        const { width, height } = e.nativeEvent.layout
        notifyTerminalFrame({ width, height })
      }}
    >
      {content}
    </View>
  )
}
