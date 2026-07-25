import { describe, expect, it, vi } from 'vitest'
import type { ThemeColors } from './mobile-theme'
import { darkColors, lightColors } from './mobile-theme'

// Why identity: factories only need key-set + deep-inequality checks; RN is unavailable in vitest.
vi.mock('react-native', () => ({
  StyleSheet: {
    create: <T extends Record<string, unknown>>(sheet: T): T => sheet,
    hairlineWidth: 1,
    absoluteFillObject: { position: 'absolute', left: 0, right: 0, top: 0, bottom: 0 }
  },
  Platform: {
    OS: 'ios',
    select: <T>(spec: { ios?: T; android?: T; default?: T }) => spec.ios ?? spec.default
  },
  View: 'View',
  Text: 'Text',
  Pressable: 'Pressable',
  TextInput: 'TextInput',
  FlatList: 'FlatList',
  ActivityIndicator: 'ActivityIndicator',
  Switch: 'Switch',
  Modal: 'Modal',
  ScrollView: 'ScrollView',
  Keyboard: { dismiss: () => undefined, addListener: () => ({ remove: () => undefined }) },
  BackHandler: { addEventListener: () => ({ remove: () => undefined }) },
  useWindowDimensions: () => ({ width: 390, height: 844 })
}))

vi.mock('lucide-react-native', () => ({
  Check: () => null,
  ChevronRight: () => null,
  Monitor: () => null,
  Edit3: () => null,
  Trash2: () => null,
  Download: () => null,
  Search: () => null,
  X: () => null
}))

vi.mock('../components/BottomDrawer', () => ({ BottomDrawer: () => null }))
vi.mock('expo-router', () => ({ router: { replace: () => undefined } }))
vi.mock('../platform/haptics', () => ({
  triggerError: () => undefined,
  triggerSuccess: () => undefined,
  triggerMediumImpact: () => undefined,
  triggerSelection: () => undefined
}))
vi.mock('../layout/responsive-layout', () => ({
  useResponsiveLayout: () => ({ isWideLayout: false, modalMaxWidth: 480, width: 390 })
}))
vi.mock('../components/AgentSpinner', () => ({ AgentSpinner: () => null }))
vi.mock('../components/AgentStateDot', () => ({ AgentStateDot: () => null }))
vi.mock('../components/MobileAgentIcon', () => ({ MobileAgentIcon: () => null }))
vi.mock('../components/MobileRepoIcon', () => ({ MobileRepoIcon: () => null }))
vi.mock('../components/WorktreeAgentList', () => ({ WorktreeAgentList: () => null }))
vi.mock('../components/pr-sidebar/pr-sidebar-status-color', () => ({
  statusColor: () => '#888'
}))
vi.mock('../transport/client-context', () => ({
  useHostClient: () => ({ client: null, state: 'disconnected' })
}))
vi.mock('../transport/host-status-gates', () => ({
  useHostStatusGates: () => ({
    compatVerdict: { kind: 'ok' },
    statusPending: false
  })
}))
vi.mock('../dictation/use-dictation-setup-poller', () => ({
  useDictationSetupPoller: () => undefined
}))
vi.mock('../dictation/mobile-dictation-setup', () => ({
  downloadDictationModel: async () => undefined,
  fetchDictationSetup: async () => null,
  isModelInFlight: () => false,
  setDictationConfig: async () => undefined
}))
vi.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 })
}))
vi.mock('react-native-gesture-handler', () => ({
  Gesture: { Pan: () => ({ onUpdate: () => ({}), onEnd: () => ({}) }) },
  GestureDetector: ({ children }: { children: unknown }) => children,
  GestureHandlerRootView: ({ children }: { children: unknown }) => children
}))
vi.mock('react-native-reanimated', () => ({
  default: {
    View: 'Animated.View',
    ScrollView: 'Animated.ScrollView',
    createAnimatedComponent: (c: unknown) => c
  },
  useSharedValue: (v: unknown) => ({ value: v }),
  useAnimatedStyle: () => ({}),
  useAnimatedScrollHandler: () => ({}),
  withSpring: (v: unknown) => v,
  withTiming: (v: unknown) => v,
  runOnJS: (fn: unknown) => fn,
  interpolate: () => 0,
  Extrapolation: { CLAMP: 'clamp' }
}))

// Appended by every themed-styles batch. Load after mocks so component modules resolve.
type StyleFactory = {
  readonly name: string
  readonly factory: (colors: ThemeColors) => Record<string, unknown>
}

async function loadThemedFactories(): Promise<readonly StyleFactory[]> {
  const mods = await Promise.all([
    import('../components/bottom-drawer-styles'),
    import('../components/PickerModal'),
    import('../components/PickerListDrawer'),
    import('../components/ConfirmModal'),
    import('../components/TextInputModal'),
    import('../components/ActionSheetModal'),
    import('../components/RightDrawer'),
    import('../components/SetupHookTrustDrawer'),
    import('../components/MobileDictationSetupSheet'),
    import('../components/MobileSearchField'),
    import('../components/WorktreeMetaGlyphs'),
    import('../components/WorktreeAgentRow'),
    import('../components/WorktreeListRow'),
    import('../components/AuthFailedBanner'),
    import('../components/HostProtocolGate'),
    import('../components/ProtocolBlockScreen'),
    import('../components/WorkspaceDetailPlaceholder'),
    import('../components/NewWorkspaceFab'),
    import('../components/AccountUsage'),
    // App screens pull expo modules that vitest cannot load; their pure style
    // module (voice-settings-styles) and co-located component factories below
    // cover batch 3. Other app factories are identity-checked via git diff -w.
    import('../../app/voice-settings-styles'),
    import('../components/ConnectionLog'),
    import('../components/VoiceModelList'),
    import('../components/terminal-shortcut-settings-styles'),
    import('../components/custom-key-modal-styles'),
    import('../session/MobileTerminalLiveInputStatus'),
    import('../components/DragReorderList'),
    import('../onboarding/mobile-onboarding-styles'),
    import('../components/MobileHostCard'),
    import('../../app/h/[hostId]/accounts-screen-styles'),
    import('../../app/h/[hostId]/host-screen-chrome-styles'),
    import('../../app/h/[hostId]/host-worktree-list-styles'),
    import('../components/smart-workspace-source-drawer-styles'),
    import('../agent-history/agent-history-styles'),
    import('../browser/MobileBrowserKeyRow'),
    import('../browser/MobileBrowserViewModeSwitch'),
    import('../../app/h/[hostId]/session/mobile-session-frame-styles'),
    import('../../app/h/[hostId]/session/mobile-session-reader-styles'),
    import('../../app/h/[hostId]/session/mobile-session-review-comment-styles'),
    import('../../app/h/[hostId]/session/mobile-session-command-input-styles'),
    import('../session/MobileAgentWorkingIndicator'),
    import('../terminal/terminal-webview-engine-error-state'),
    import('../session/mobile-native-chat-view-styles'),
    import('../session/mobile-native-chat-message-styles'),
    import('../components/mobile-markdown-styles'),
    import('../components/mobile-diff-review-control-styles'),
    import('../components/mobile-diff-review-layout-styles'),
    import('../components/mobile-diff-review-screen-styles'),
    import('../components/MobileSyntaxSegments'),
    import('../source-control/mobile-source-control-hub-styles'),
    import('../source-control/mobile-source-control-list-styles'),
    import('../source-control/mobile-source-control-diff-styles'),
    import('../source-control/mobile-source-control-styles'),
    import('../files/mobile-file-explorer-styles'),
    import('../files/mobile-file-preview-styles'),
    import('../components/pr-sidebar/mobile-pr-sidebar-styles'),
    import('../components/pr-sidebar/pr-ai-triage-styles'),
    import('../components/pr-sidebar/pr-conflict-styles'),
    import('../components/pr-sidebar/pr-comments-styles'),
    import('../components/pr-sidebar/pr-comment-composer-styles'),
    import('../components/pr-sidebar/mobile-pr-compose-form-styles'),
    import('../components/pr-sidebar/pr-actions-styles'),
    import('../components/pr-sidebar/pr-create-empty-state-styles')
  ])
  const [
    bottomDrawer,
    pickerModal,
    pickerList,
    confirm,
    textInput,
    actionSheet,
    rightDrawer,
    setupTrust,
    dictation,
    searchField,
    metaGlyphs,
    agentRow,
    listRow,
    authBanner,
    protocolGate,
    protocolBlock,
    placeholder,
    fab,
    accountUsage,
    voiceSettings,
    connectionLog,
    voiceModelList,
    shortcutSettings,
    customKeyModal,
    liveInputStatus,
    dragReorderList,
    onboarding,
    hostCard,
    accountsScreen,
    hostChrome,
    hostList,
    smartDrawer,
    agentHistory,
    browserKeyRow,
    browserViewMode,
    sessionFrame,
    sessionReader,
    sessionReview,
    sessionCommand,
    workingIndicator,
    engineError,
    nativeChatView,
    nativeChatMessage,
    markdownStyles,
    diffControl,
    diffLayout,
    diffScreen,
    syntaxSegments,
    scHub,
    scList,
    scDiff,
    scStyles,
    fileExplorer,
    filePreview,
    prSidebar,
    prAiTriage,
    prConflict,
    prComments,
    prCommentComposer,
    prComposeForm,
    prActions,
    prCreateEmpty
  ] = mods
  return [
    { name: 'createBottomDrawerStyles', factory: bottomDrawer.createBottomDrawerStyles },
    { name: 'createPickerModalStyles', factory: pickerModal.createPickerModalStyles },
    { name: 'createPickerListDrawerStyles', factory: pickerList.createPickerListDrawerStyles },
    { name: 'createConfirmModalStyles', factory: confirm.createConfirmModalStyles },
    { name: 'createTextInputModalStyles', factory: textInput.createTextInputModalStyles },
    { name: 'createActionSheetModalStyles', factory: actionSheet.createActionSheetModalStyles },
    { name: 'createRightDrawerStyles', factory: rightDrawer.createRightDrawerStyles },
    {
      name: 'createSetupHookTrustDrawerStyles',
      factory: setupTrust.createSetupHookTrustDrawerStyles
    },
    {
      name: 'createMobileDictationSetupSheetStyles',
      factory: dictation.createMobileDictationSetupSheetStyles
    },
    { name: 'createMobileSearchFieldStyles', factory: searchField.createMobileSearchFieldStyles },
    { name: 'createWorktreeMetaGlyphsStyles', factory: metaGlyphs.createWorktreeMetaGlyphsStyles },
    { name: 'createWorktreeAgentRowStyles', factory: agentRow.createWorktreeAgentRowStyles },
    { name: 'createWorktreeListRowStyles', factory: listRow.createWorktreeListRowStyles },
    { name: 'createAuthFailedBannerStyles', factory: authBanner.createAuthFailedBannerStyles },
    { name: 'createHostProtocolGateStyles', factory: protocolGate.createHostProtocolGateStyles },
    {
      name: 'createProtocolBlockScreenStyles',
      factory: protocolBlock.createProtocolBlockScreenStyles
    },
    {
      name: 'createWorkspaceDetailPlaceholderStyles',
      factory: placeholder.createWorkspaceDetailPlaceholderStyles
    },
    { name: 'createNewWorkspaceFabStyles', factory: fab.createNewWorkspaceFabStyles },
    { name: 'createAccountUsageStyles', factory: accountUsage.createAccountUsageStyles },
    { name: 'createVoiceSettingsStyles', factory: voiceSettings.createVoiceSettingsStyles },
    { name: 'createConnectionLogStyles', factory: connectionLog.createConnectionLogStyles },
    { name: 'createVoiceModelListStyles', factory: voiceModelList.createVoiceModelListStyles },
    {
      name: 'createTerminalShortcutSettingsStyles',
      factory: shortcutSettings.createTerminalShortcutSettingsStyles
    },
    { name: 'createCustomKeyModalStyles', factory: customKeyModal.createCustomKeyModalStyles },
    {
      name: 'createMobileTerminalLiveInputStatusStyles',
      factory: liveInputStatus.createMobileTerminalLiveInputStatusStyles
    },
    { name: 'createDragReorderListStyles', factory: dragReorderList.createDragReorderListStyles },
    { name: 'createMobileOnboardingStyles', factory: onboarding.createMobileOnboardingStyles },
    { name: 'createMobileHostCardStyles', factory: hostCard.createMobileHostCardStyles },
    {
      name: 'createAccountsScreenStyles',
      factory: accountsScreen.createAccountsScreenStyles
    },
    {
      name: 'createHostScreenChromeStyles',
      factory: hostChrome.createHostScreenChromeStyles
    },
    {
      name: 'createHostWorktreeListStyles',
      factory: hostList.createHostWorktreeListStyles
    },
    {
      name: 'createSmartWorkspaceSourceDrawerStyles',
      factory: smartDrawer.createSmartWorkspaceSourceDrawerStyles
    },
    { name: 'createAgentHistoryStyles', factory: agentHistory.createAgentHistoryStyles },
    {
      name: 'createMobileBrowserKeyRowStyles',
      factory: browserKeyRow.createMobileBrowserKeyRowStyles
    },
    {
      name: 'createMobileBrowserViewModeSwitchStyles',
      factory: browserViewMode.createMobileBrowserViewModeSwitchStyles
    },
    {
      name: 'createMobileSessionFrameStyles',
      factory: sessionFrame.createMobileSessionFrameStyles
    },
    {
      name: 'createMobileSessionReaderStyles',
      factory: sessionReader.createMobileSessionReaderStyles
    },
    {
      name: 'createMobileSessionReviewCommentStyles',
      factory: sessionReview.createMobileSessionReviewCommentStyles
    },
    {
      name: 'createMobileSessionCommandInputStyles',
      factory: sessionCommand.createMobileSessionCommandInputStyles
    },
    {
      name: 'createMobileAgentWorkingIndicatorStyles',
      factory: workingIndicator.createMobileAgentWorkingIndicatorStyles
    },
    {
      name: 'createTerminalWebViewEngineErrorStyles',
      factory: engineError.createTerminalWebViewEngineErrorStyles
    },
    {
      name: 'createMobileNativeChatViewStyles',
      factory: nativeChatView.createMobileNativeChatViewStyles
    },
    {
      name: 'createMobileNativeChatMessageStyles',
      factory: nativeChatMessage.createMobileNativeChatMessageStyles
    },
    {
      name: 'createMobileMarkdownStyles',
      factory: markdownStyles.createMobileMarkdownStyles
    },
    {
      name: 'createMobileDiffReviewControlStyles',
      factory: diffControl.createMobileDiffReviewControlStyles
    },
    {
      name: 'createMobileDiffReviewLayoutStyles',
      factory: diffLayout.createMobileDiffReviewLayoutStyles
    },
    {
      name: 'createMobileDiffReviewStyles',
      factory: diffScreen.createMobileDiffReviewStyles
    },
    {
      name: 'createMobileSyntaxTokenStyles',
      factory: syntaxSegments.createMobileSyntaxTokenStyles
    },
    {
      name: 'createMobileSourceControlHubStyles',
      factory: scHub.createMobileSourceControlHubStyles
    },
    {
      name: 'createMobileSourceControlListStyles',
      factory: scList.createMobileSourceControlListStyles
    },
    {
      name: 'createMobileSourceControlDiffStyles',
      factory: scDiff.createMobileSourceControlDiffStyles
    },
    {
      name: 'createMobileSourceControlStyles',
      factory: scStyles.createMobileSourceControlStyles
    },
    {
      name: 'createMobileFileExplorerStyles',
      factory: fileExplorer.createMobileFileExplorerStyles
    },
    {
      name: 'createMobileFilePreviewStyles',
      factory: filePreview.createMobileFilePreviewStyles
    },
    {
      name: 'createMobilePrSidebarStyles',
      factory: prSidebar.createMobilePrSidebarStyles
    },
    {
      name: 'createPrAiTriageStyles',
      factory: prAiTriage.createPrAiTriageStyles
    },
    {
      name: 'createPrConflictStyles',
      factory: prConflict.createPrConflictStyles
    },
    {
      name: 'createPrCommentsStyles',
      factory: prComments.createPrCommentsStyles
    },
    {
      name: 'createPrCommentComposerStyles',
      factory: prCommentComposer.createPrCommentComposerStyles
    },
    {
      name: 'createMobilePrComposeFormStyles',
      factory: prComposeForm.createMobilePrComposeFormStyles
    },
    {
      name: 'createPrActionsStyles',
      factory: prActions.createPrActionsStyles
    },
    {
      name: 'createPrCreateEmptyStateStyles',
      factory: prCreateEmpty.createPrCreateEmptyStateStyles
    }
  ]
}

describe('themed style factories', () => {
  it('emits the same keys in both palettes and differs in value', async () => {
    const factories = await loadThemedFactories()
    for (const { name, factory } of factories) {
      const darkSheet = factory(darkColors)
      const lightSheet = factory(lightColors)
      expect(Object.keys(darkSheet).sort(), name).toEqual(Object.keys(lightSheet).sort())
      expect(darkSheet, name).not.toEqual(lightSheet)
    }
  })

  it('keeps dark palette values byte-identical to pre-conversion tokens', async () => {
    const { createBottomDrawerStyles } = await import('../components/bottom-drawer-styles')
    const { createConfirmModalStyles } = await import('../components/ConfirmModal')
    const { createNewWorkspaceFabStyles } = await import('../components/NewWorkspaceFab')
    const { createAuthFailedBannerStyles } = await import('../components/AuthFailedBanner')

    // Behavioural identity: same tokens reach the same style properties under dark.
    const drawer = createBottomDrawerStyles(darkColors)
    expect(drawer.drawer.backgroundColor).toBe(darkColors.bgBase)
    expect(drawer.handle.backgroundColor).toBe(darkColors.textMuted)
    // Scrim stays a fixed literal in both modes (desktop uses one scrim; STYLEGUIDE Floating).
    expect(drawer.backdrop.backgroundColor).toBe('rgba(0,0,0,0.5)')

    const confirm = createConfirmModalStyles(darkColors)
    expect(confirm.title.color).toBe(darkColors.textPrimary)
    expect(confirm.destructiveButton.backgroundColor).toBe(darkColors.statusRed)
    expect(confirm.destructiveText.color).toBe('#fff')

    const fab = createNewWorkspaceFabStyles(darkColors)
    expect(fab.fab.backgroundColor).toBe(darkColors.surfaceBright)
    expect(fab.fabPressed.backgroundColor).toBe(darkColors.surfaceBrightPressed)
    expect(fab.fab.shadowColor).toBe('#000')

    const banner = createAuthFailedBannerStyles(darkColors)
    expect(banner.text.color).toBe(darkColors.statusRed)
    expect(banner.actionText.color).toBe(darkColors.accentBlue)

    const { createVoiceSettingsStyles } = await import('../../app/voice-settings-styles')
    const { createConnectionLogStyles } = await import('../components/ConnectionLog')
    const voice = createVoiceSettingsStyles(darkColors)
    expect(voice.container.backgroundColor).toBe(darkColors.bgBase)
    expect(voice.heading.color).toBe(darkColors.textPrimary)
    const log = createConnectionLogStyles(darkColors)
    expect(log.timestamp.color).toBe(darkColors.textMuted)

    const { createTerminalShortcutSettingsStyles } =
      await import('../components/terminal-shortcut-settings-styles')
    const { createCustomKeyModalStyles } = await import('../components/custom-key-modal-styles')
    const shortcuts = createTerminalShortcutSettingsStyles(darkColors)
    expect(shortcuts.keycap.backgroundColor).toBe(darkColors.bgRaised)
    // Delete affordance keeps its literal red wash in both modes (statusRed at 10%).
    expect(shortcuts.deleteButton.backgroundColor).toBe('rgba(239, 68, 68, 0.1)')
    const customKey = createCustomKeyModalStyles(darkColors)
    expect(customKey.title.color).toBe(darkColors.textPrimary)

    const { createMobileOnboardingStyles } = await import('../onboarding/mobile-onboarding-styles')
    const { createMobileHostCardStyles } = await import('../components/MobileHostCard')
    const onboarding = createMobileOnboardingStyles(darkColors)
    expect(onboarding.container.backgroundColor).toBe(darkColors.bgBase)
    expect(onboarding.primaryButton.backgroundColor).toBe(darkColors.surfaceBright)
    const hostCard = createMobileHostCardStyles(darkColors)
    expect(hostCard.card.backgroundColor).toBe(darkColors.bgPanel)
    expect(hostCard.cardPressed.backgroundColor).toBe(darkColors.bgRaised)

    const { createAccountsScreenStyles } =
      await import('../../app/h/[hostId]/accounts-screen-styles')
    const { createHostScreenChromeStyles } =
      await import('../../app/h/[hostId]/host-screen-chrome-styles')
    const { createHostWorktreeListStyles } =
      await import('../../app/h/[hostId]/host-worktree-list-styles')
    const accounts = createAccountsScreenStyles(darkColors)
    expect(accounts.container.backgroundColor).toBe(darkColors.bgBase)
    expect(accounts.rowTitle.color).toBe(darkColors.textPrimary)
    const chrome = createHostScreenChromeStyles(darkColors)
    expect(chrome.container.backgroundColor).toBe(darkColors.bgBase)
    expect(chrome.hostNameText.color).toBe(darkColors.textPrimary)
    const list = createHostWorktreeListStyles(darkColors)
    expect(list.sectionTitle.color).toBe(darkColors.textMuted)
    expect(list.confirmBtnDestructive.backgroundColor).toBe(darkColors.statusRed)
    expect(list.confirmBtnDestructiveText.color).toBe('#fff')

    const { createSmartWorkspaceSourceDrawerStyles } =
      await import('../components/smart-workspace-source-drawer-styles')
    const { createAgentHistoryStyles } = await import('../agent-history/agent-history-styles')
    const smartDrawerSheet = createSmartWorkspaceSourceDrawerStyles(darkColors)
    expect(smartDrawerSheet.title.color).toBe(darkColors.textPrimary)
    const history = createAgentHistoryStyles(darkColors)
    expect(history.container.backgroundColor).toBe(darkColors.bgBase)
    expect(history.title.color).toBe(darkColors.textPrimary)

    const { createMobileSessionFrameStyles } =
      await import('../../app/h/[hostId]/session/mobile-session-frame-styles')
    const { createTerminalWebViewEngineErrorStyles } =
      await import('../terminal/terminal-webview-engine-error-state')
    const frame = createMobileSessionFrameStyles(darkColors)
    expect(frame.container.backgroundColor).toBe(darkColors.bgBase)
    const err = createTerminalWebViewEngineErrorStyles(darkColors)
    expect(err.errorOverlay.backgroundColor).toBe(darkColors.terminalBg)
    expect(err.errorTitle.color).toBe(darkColors.textPrimary)

    const { createMobileNativeChatViewStyles } =
      await import('../session/mobile-native-chat-view-styles')
    const { createMobileNativeChatMessageStyles } =
      await import('../session/mobile-native-chat-message-styles')
    const chatView = createMobileNativeChatViewStyles(darkColors)
    expect(chatView.root.backgroundColor).toBe(darkColors.bgBase)
    expect(chatView.sendErrorText.color).toBe(darkColors.statusRed)
    const chatMsg = createMobileNativeChatMessageStyles(darkColors)
    expect(chatMsg.userText.color).toBe(darkColors.bgBase)

    const { createMobileMarkdownStyles } = await import('../components/mobile-markdown-styles')
    const { createMobileDiffReviewControlStyles } =
      await import('../components/mobile-diff-review-control-styles')
    const { createMobileDiffReviewLayoutStyles } =
      await import('../components/mobile-diff-review-layout-styles')
    const { createMobileDiffReviewStyles } =
      await import('../components/mobile-diff-review-screen-styles')
    const { createMobileSyntaxTokenStyles } = await import('../components/MobileSyntaxSegments')
    const md = createMobileMarkdownStyles(darkColors)
    expect(md.paragraph.color).toBe(darkColors.textPrimary)
    expect(md.link.color).toBe(darkColors.accentBlue)
    const control = createMobileDiffReviewControlStyles(darkColors)
    expect(control.footer.backgroundColor).toBe(darkColors.bgBase)
    const layout = createMobileDiffReviewLayoutStyles(darkColors)
    expect(layout.safeArea.backgroundColor).toBe(darkColors.bgBase)
    const review = createMobileDiffReviewStyles(darkColors)
    expect(review.safeArea.backgroundColor).toBe(darkColors.bgBase)
    expect(review.footer.backgroundColor).toBe(darkColors.bgBase)
    const syntax = createMobileSyntaxTokenStyles(darkColors)
    expect(syntax.keyword.color).toBe(darkColors.syntaxKeyword)

    const { createMobileSourceControlHubStyles } =
      await import('../source-control/mobile-source-control-hub-styles')
    const { createMobileSourceControlListStyles } =
      await import('../source-control/mobile-source-control-list-styles')
    const { createMobileSourceControlDiffStyles } =
      await import('../source-control/mobile-source-control-diff-styles')
    const { createMobileSourceControlStyles } =
      await import('../source-control/mobile-source-control-styles')
    const hub = createMobileSourceControlHubStyles(darkColors)
    expect(hub.segments.backgroundColor).toBe(darkColors.bgPanel)
    const scListSheet = createMobileSourceControlListStyles(darkColors)
    expect(scListSheet.sectionTitle.color).toBe(darkColors.textSecondary)
    const scDiffSheet = createMobileSourceControlDiffStyles(darkColors)
    expect(scDiffSheet.stateTitle.color).toBe(darkColors.textPrimary)
    const sc = createMobileSourceControlStyles(darkColors)
    expect(sc.container.backgroundColor).toBe(darkColors.bgBase)
    expect(sc.listContent.paddingBottom).toBe(136)
    expect(sc.stateTitle.color).toBe(darkColors.textPrimary)

    const { createMobileFileExplorerStyles } = await import('../files/mobile-file-explorer-styles')
    const { createMobileFilePreviewStyles } = await import('../files/mobile-file-preview-styles')
    const explorer = createMobileFileExplorerStyles(darkColors)
    expect(explorer.container.backgroundColor).toBe(darkColors.bgBase)
    const preview = createMobileFilePreviewStyles(darkColors)
    expect(preview.container.backgroundColor).toBe(darkColors.bgBase)

    const { createMobilePrSidebarStyles } =
      await import('../components/pr-sidebar/mobile-pr-sidebar-styles')
    const { createPrAiTriageStyles } = await import('../components/pr-sidebar/pr-ai-triage-styles')
    const { createPrConflictStyles } = await import('../components/pr-sidebar/pr-conflict-styles')
    const pr = createMobilePrSidebarStyles(darkColors)
    expect(pr.dockColumn.backgroundColor).toBe(darkColors.bgPanel)
    const triage = createPrAiTriageStyles(darkColors)
    expect(triage.triageArea.gap).toBeDefined()
    const conflict = createPrConflictStyles(darkColors)
    expect(conflict.meta.color).toBe(darkColors.textSecondary)

    const { createPrCommentsStyles } = await import('../components/pr-sidebar/pr-comments-styles')
    const { createPrCommentComposerStyles } =
      await import('../components/pr-sidebar/pr-comment-composer-styles')
    const comments = createPrCommentsStyles(darkColors)
    expect(comments.card.backgroundColor).toBe(darkColors.bgPanel)
    const composer = createPrCommentComposerStyles(darkColors)
    expect(composer.input.color).toBe(darkColors.textPrimary)

    const { createMobilePrComposeFormStyles } =
      await import('../components/pr-sidebar/mobile-pr-compose-form-styles')
    const { createPrActionsStyles } = await import('../components/pr-sidebar/pr-actions-styles')
    const { createPrCreateEmptyStateStyles } =
      await import('../components/pr-sidebar/pr-create-empty-state-styles')
    const compose = createMobilePrComposeFormStyles(darkColors)
    expect(compose.headingTitle.flex).toBe(1)
    const actions = createPrActionsStyles(darkColors)
    expect(actions.actionButton.backgroundColor).toBe(darkColors.bgRaised)
    const empty = createPrCreateEmptyStateStyles(darkColors)
    expect(empty.section.backgroundColor).toBe(darkColors.bgPanel)
  })
})
