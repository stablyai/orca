import { Animated, View, Text, Pressable, ActivityIndicator } from 'react-native'
import { saveTerminalTextScale } from '../storage/preferences'
import { MobileBrowserPane } from '../browser/MobileBrowserPane'
import { TerminalPaneView } from './TerminalPaneView'
import { MobileNativeChatOverlay } from './MobileNativeChatOverlay'
import { resolveMobileNativeChatSessionId } from './native-chat/mobile-native-chat-eligibility'
import { colors } from '../theme/mobile-theme'
import { useMobileColorScheme } from '../theme/use-mobile-color-scheme'
import { styles } from './mobile-session-styles'
import type { MobileSessionController } from './use-mobile-session-controller'
import { useWorkspaceExecutionHost } from '../navigation/workspace-execution-host'
import { useHostProfile } from '../transport/use-host-profile'
import { useHostDisplay } from '../transport/use-host-display'
import { FileReader } from './MobileSessionFileReader'
import { MarkdownReader } from './MobileSessionMarkdownReader'

export function MobileSessionActiveContent({
  controller
}: {
  controller: MobileSessionController
}) {
  useMobileColorScheme()
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
    keyboardLift,
    activeTerminalKeyboardLift,
    toastAnimatedStyle,
    createTabBusy
  } = controller
  const hostProfile = useHostProfile(hostId)
  const hostTitle = useHostDisplay(hostProfile).title
  const content = showLoadingState ? (
    <View style={styles.emptyState}>
      <ActivityIndicator size="small" color={colors.textSecondary} />
    </View>
  ) : showEmptyState ? (
    <View style={styles.emptyState}>
      <Text style={styles.emptyText}>No tabs in this session</Text>
      {createError ? <Text style={styles.createError}>{createError}</Text> : null}
      <View style={styles.emptyActions}>
        <Pressable
          style={[
            styles.createButton,
            (createTabBusy || connState !== 'connected') && styles.createButtonDisabled
          ]}
          disabled={createTabBusy || connState !== 'connected'}
          onPress={() => {
            setCreateError('')
            setShowCreateTabDrawer(true)
          }}
        >
          <Text style={styles.createButtonText}>
            {createTabBusy ? 'Creating...' : 'Create Tab'}
          </Text>
        </Pressable>
      </View>
    </View>
  ) : activeMarkdownTab ? (
    <View style={styles.markdownFrame}>
      <MarkdownReader
        documentId={activeMarkdownTab.id}
        doc={markdownDocs.get(activeMarkdownTab.id)}
        onRefresh={() => void readMarkdownTab(activeMarkdownTab)}
        onChange={(content) => updateMarkdownLocalContent(activeMarkdownTab.id, content)}
        onSave={() => void saveMarkdownTab(activeMarkdownTab)}
        onCopy={() => void copyMarkdownLocalContent(activeMarkdownTab.id)}
        onCopyPath={() => void copyMarkdownPath(activeMarkdownTab)}
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
    <View style={styles.emptyState}>
      {!isPendingTerminalRecoveryParked && (
        <ActivityIndicator size="small" color={colors.textSecondary} />
      )}
      <Text style={styles.emptyText}>
        {isPendingTerminalRecoveryParked
          ? 'Terminal is taking longer than expected'
          : activePendingTerminalTab.title || 'Loading terminal'}
      </Text>
      {isPendingTerminalRecoveryParked && (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Retry loading terminal"
          style={({ pressed }) => [styles.createButton, pressed && styles.newTerminalButtonPressed]}
          onPress={() => void retryPendingTerminalRecovery()}
        >
          <Text style={styles.createButtonText}>Retry</Text>
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
