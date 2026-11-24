import { useCallback, useMemo } from 'react'
import { StyleSheet, View } from 'react-native'
import type { ExecutionHostId } from '../../../src/shared/execution-host/execution-host'
import { useOpenHostAccounts } from '../accounts/use-open-mobile-accounts'
import { renderAnimatedToast } from '../components/feedback/TransientToast'
import { useHostProfile } from '../host-catalog/use-host-profile'
import type { ReleasedSideInset } from '../layout/released-side-inset'
import { useMobileColorScheme } from '../theme/use-mobile-color-scheme'
import { useMobileTranslation } from '../i18n/use-mobile-translation'
import { computeActiveTerminalKeyboardLift } from '../terminal/keyboard/terminal-keyboard-avoidance-lift'
import { terminalPaneKeyboardLayout } from '../terminal/session/pane-layout/mobile-terminal-pane-layout'
import { MountedTerminalPanes } from '../terminal/session/pane-layout/mounted-terminal-lru'
import { TerminalPaneView } from '../terminal/session/pane-layout/TerminalPaneView'
import type { TerminalFrame } from '../terminal/webview/terminal-webview-messages'
import { useMobileTerminalLinkOpen } from '../terminal/session/links/use-mobile-terminal-link-open'
import { useOpenUrlInOrca } from '../browser/tab-navigation/use-open-url-in-orca'
import { MobileNativeChatForkProvider } from './MobileNativeChatForkProvider'
import { sideStripOffset } from './session-side-strip-inset'
import { styles } from './mobile-session-styles'
import type { MobileSessionController } from './use-mobile-session-controller'
import { useMobileAgentMessageNavigation } from './use-mobile-agent-message-navigation'
import { MobileSessionBotIdentity } from './native-chat/MobileSessionBotIdentity'
import { MobileNativeChatOverlay } from './native-chat/MobileNativeChatOverlay'
import { nativeChatTerminalRunner } from './native-chat/native-chat-terminal-runner'
import { mobileSessionNativeChatHostOutage } from './native-chat/status/mobile-native-chat-host-outage'
import { MobileAgentMessageProvider } from './native-chat/transcript/agent-messages/MobileAgentMessageProvider'
import { MobileBotCardHostProvider } from './native-chat/transcript/bot-cards/MobileBotCardHostProvider'
import { MobileNativeChatDictationPreviewContext } from './native-chat/composer/dictation/mobile-native-chat-dictation-preview-context'
import { resolveMobileNativeChatSessionId } from './native-chat/conversation/mobile-native-chat-eligibility'

/** Terminal panes and the chat laid over them, shifted clear of a released side strip. */
export function MobileSessionTerminalStage({
  controller,
  stripInset,
  paneFrame,
  paneDirection,
  keyboardLift,
  activeTerminalKeyboardLift,
  executionHost,
  hostTitle,
  toast
}: {
  controller: MobileSessionController
  stripInset: ReleasedSideInset | null
  paneFrame: TerminalFrame
  paneDirection: 'row' | 'column'
  keyboardLift: number
  activeTerminalKeyboardLift: number
  executionHost: ExecutionHostId | undefined
  hostTitle: string
  toast: ReturnType<typeof renderAnimatedToast>
}) {
  useMobileColorScheme()
  const t = useMobileTranslation()
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
    dictationMode,
    dictationEnabled,
    nativeChatSendError,
    nativeChatOverlayInputLockReason,
    nativeChatController,
    dictation,
    chatDictationPreview,
    handleDictationToggle,
    handleDictationPressIn,
    handleDictationPressOut,
    setTerminalWebViewRef,
    releaseTerminalDocument,
    handleTerminalWebReady,
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
    handleTerminalInteraction,
    handleTerminalTap,
    nativeChatImages,
    nativeChatStructuredComposer
  } = controller
  const openUrlInOrca = useOpenUrlInOrca(controller)
  const terminalLinks = useMobileTerminalLinkOpen(controller, openUrlInOrca)
  const hostProfile = useHostProfile(hostId)
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
  return (
    <View style={styles.terminalFrame}>
      <View style={[StyleSheet.absoluteFill, sideStripOffset(stripInset)]}>
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
                  hostName={executionHost === undefined && hostProfile ? hostTitle : null}
                  onOpenUrlInOrca={openUrlInOrca}
                  linkOpenMode={controller.linkOpenMode}
                  hostOutage={nativeChatHostOutage}
                  onRunInTerminal={nativeChatTerminalRunner(controller)}
                  onOpenAccounts={executionHost === undefined ? openNativeChatAccounts : undefined}
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
}
