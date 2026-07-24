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
    import('../components/DragReorderList')
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
    dragReorderList
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
    { name: 'createDragReorderListStyles', factory: dragReorderList.createDragReorderListStyles }
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
  })
})
