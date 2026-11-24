import { useState } from 'react'
import { terminalPaneDirection } from '../terminal/session/pane-layout/mobile-terminal-pane-layout'
import { View, Text, Pressable, ActivityIndicator } from 'react-native'
import { sideStripMargin, useSessionSideStripInset } from './session-side-strip-inset'
import { MobileBrowserTabBody } from '../browser/MobileBrowserTabBody'
import { colors } from '../theme/mobile-theme'
import { useMobileColorScheme } from '../theme/use-mobile-color-scheme'
import { useMobileTranslation } from '../i18n/use-mobile-translation'
import { styles } from './mobile-session-styles'
import { renderAnimatedToast } from '../components/feedback/TransientToast'
import type { MobileSessionController } from './use-mobile-session-controller'
import { useMobileSessionContentKeyboardLift } from '../terminal/session/input-controls/use-mobile-session-keyboard-lift'
import { useWorkspaceExecutionHost } from '../navigation/workspace-execution-host'
import { useHostProfile } from '../host-catalog/use-host-profile'
import { useHostDisplay } from '../host-descriptors/use-host-display'
import { FileReader } from '../files/session-documents/MobileSessionFileReader'
import { MobileSessionContentState } from './MobileSessionContentState'
import { MobileSessionTerminalStage } from './MobileSessionTerminalStage'
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
  const { main: stripInset } = useSessionSideStripInset(
    controller.canDockPanel && controller.activePanel !== null
  )
  const paneDirection = terminalPaneDirection(paneFrame, controller.terminalSplitLayout)
  const {
    hostId,
    worktreeId,
    client,
    diffComments,
    diffCommentBusy,
    createError,
    setCreateError,
    setShowCreateTabDrawer,
    toastMessage,
    browserScreencastSupported,
    showToast,
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
    notifyTerminalFrame,
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
  const hostProfile = useHostProfile(hostId)
  const hostTitle = useHostDisplay(hostProfile).title
  const { presentedConnState, showOfflineState, forceReconnectHost } = controller
  // Review notes are for working-tree diffs only.
  const fileTabTakesNotes =
    activeFileTab?.diffSource === 'staged' || activeFileTab?.diffSource === 'unstaged'
  const toast = renderAnimatedToast(toastMessage, toastAnimatedStyle)
  const terminalBranch = !(
    showLoadingState ||
    showEmptyState ||
    showOfflineState ||
    activeMarkdownTab ||
    activeFileTab ||
    activeBrowserTab ||
    activePendingTerminalTab
  )
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
      <MobileSessionTerminalStage
        controller={controller}
        stripInset={stripInset}
        paneFrame={paneFrame}
        paneDirection={paneDirection}
        keyboardLift={keyboardLift}
        activeTerminalKeyboardLift={activeTerminalKeyboardLift}
        executionHost={executionHost}
        hostTitle={hostTitle}
        toast={toast}
      />
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
