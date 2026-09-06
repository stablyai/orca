import { describe, expect, it } from 'vitest'
import { readMobileSessionRouteSource } from './mobile-session-route-source-family.test-support'

const runtimeSource = readMobileSessionRouteSource('./use-mobile-session-terminal-runtime.ts')
const nativeChatSource = readMobileSessionRouteSource(
  './use-mobile-session-native-chat-dictation.ts'
)
const sendActionsSource = readMobileSessionRouteSource(
  './use-mobile-session-terminal-send-actions.ts'
)
const commandDockSource = readMobileSessionRouteSource('./MobileSessionCommandDock.tsx')
const tabApplicationSource = readMobileSessionRouteSource('./use-mobile-session-tab-application.ts')
const terminalListSource = readMobileSessionRouteSource('./use-mobile-session-terminal-list.ts')
const startupSource = readMobileSessionRouteSource('./use-mobile-session-startup.ts')
const bufferedDraftHookSource = readMobileSessionRouteSource(
  '../terminal/use-buffered-terminal-drafts.ts'
)
const keyboardDismissalHookSource = readMobileSessionRouteSource(
  './use-agent-send-keyboard-dismissal.ts'
)

function sourceSlice(source: string, anchorStart: string, anchorEnd: string): string {
  const start = source.indexOf(anchorStart)
  expect(start).toBeGreaterThanOrEqual(0)
  // Why: a duplicated start anchor would silently slice the wrong region.
  expect(source.indexOf(anchorStart, start + 1)).toBe(-1)
  const end = source.indexOf(anchorEnd, start)
  expect(end).toBeGreaterThan(start)
  return source.slice(start, end + anchorEnd.length)
}

describe('terminal send keyboard dismissal wiring', () => {
  it('gates the dismissal on the agent-session predicate', () => {
    const slice = sourceSlice(
      sendActionsSource,
      'const dismissKeyboardAfterAgentSend = useAgentSendKeyboardDismissal(',
      'getSendCompletionGeneration\n  )'
    )
    expect(slice).toContain('dismissSoftwareKeyboard')
    expect(keyboardDismissalHookSource).toContain(
      'shouldDismissKeyboardAfterTerminalSend(origin.tab, accepted)'
    )
    expect(keyboardDismissalHookSource).toContain(
      'origin.generation === getSendCompletionGeneration()'
    )
    expect(keyboardDismissalHookSource).toContain('dismissSoftwareKeyboard()')
    expect(keyboardDismissalHookSource).toContain('return useCallback(')
    expect(sendActionsSource).toContain(
      "import { useAgentSendKeyboardDismissal } from './use-agent-send-keyboard-dismissal'"
    )
  })

  it('invalidates pending terminal sends when the focused input surface changes', () => {
    const slice = sourceSlice(
      nativeChatSource,
      'const getSendCompletionGeneration = useMobileSendCompletionGeneration({',
      '})'
    )
    expect(nativeChatSource).toContain(
      'const routeKey = nativeChatScopeKey ?? `${hostId}\\0${worktreeId}`'
    )
    expect(slice).toContain(
      'surfaceKey: JSON.stringify([routeKey, activeHandle, showNativeChat, liveInputEnabled])'
    )
  })

  it('dismisses after the live input submits, which is the only Enter path', () => {
    // terminal-live-input.ts deliberately keeps Enter off the key map, so
    // onSubmitEditing is the single send seam for the live field.
    const slice = sourceSlice(commandDockSource, 'ref={liveInputRef}', 'importantForAutofill="no"')
    expect(slice).toContain('generation: getSendCompletionGeneration()')
    expect(slice).toContain('const submit = handleLiveInputSubmit()')
    expect(slice).toContain('interaction: getLiveInteractionGeneration()')
    expect(slice).toContain('sendOrigin.interaction === getLiveInteractionGeneration()')
    expect(slice).toContain('dismissKeyboardAfterAgentSend(')
    // Explicit dismissal replaces RN's blur, which stays off so a shell send
    // does not drop focus.
    expect(slice).toContain('blurOnSubmit={false}')
  })

  it('dismisses the buffered command send only once the write is accepted', () => {
    const slice = sourceSlice(
      sendActionsSource,
      'async function handleSend() {',
      'async function handleAccessoryKey('
    )
    const acceptedAt = slice.indexOf('const accepted = isTerminalSendRpcAccepted(response)')
    const restoreAt = slice.indexOf('restoreRejectedDraft()', acceptedAt)
    const dismissAt = slice.indexOf('dismissKeyboardAfterAgentSend(')
    const responseAt = slice.indexOf('const response = await client.sendRequest(')
    const catchAt = slice.indexOf('} catch {')
    expect(dismissAt).toBeGreaterThan(0)
    expect(responseAt).toBeGreaterThan(0)
    expect(acceptedAt).toBeGreaterThan(responseAt)
    expect(restoreAt).toBeGreaterThan(acceptedAt)
    expect(dismissAt).toBeGreaterThan(responseAt)
    expect(slice).toContain(
      'const draftUnchanged =\n        accepted && bufferedTerminalDraftState.settleBufferedTerminalDraftSend(bufferedDraftSend)'
    )
    expect(slice).toContain('dismissKeyboardAfterAgentSend(sendOrigin, accepted && draftUnchanged)')
    expect(catchAt).toBeGreaterThan(0)
    // Both resolved rejections and transport failures restore the raw draft.
    expect(dismissAt).toBeLessThan(catchAt)
    expect(slice.slice(catchAt)).not.toContain('dismissKeyboardAfterAgentSend(')
    expect(slice.slice(catchAt)).toContain('restoreRejectedDraft()')
  })

  it('keeps buffered Return focused until accepted-agent dismissal runs', () => {
    const slice = sourceSlice(
      commandDockSource,
      'ref={commandInputRef}',
      'onSubmitEditing={() => void handleSend()}'
    )
    expect(slice).toContain('blurOnSubmit={false}')
  })

  it('restores a rejected buffered draft by origin without generation fencing', () => {
    const sendSlice = sourceSlice(
      sendActionsSource,
      'async function handleSend() {',
      'async function handleAccessoryKey('
    )
    const originAt = sendSlice.indexOf('handle: activeHandle')
    const requestAt = sendSlice.indexOf('await client.sendRequest(')
    const restoreSlice = sourceSlice(
      sendActionsSource,
      'const bufferedDraftSend = bufferedTerminalDraftState.beginBufferedTerminalDraftSend(',
      'bufferedTerminalDraftState.restoreRejectedDraft(bufferedDraftSend)'
    )
    expect(originAt).toBeGreaterThan(0)
    expect(originAt).toBeLessThan(requestAt)
    expect(restoreSlice).toContain('activeHandle,\n      draft')
    expect(bufferedDraftHookSource).not.toContain('getSendCompletionGeneration()')
    expect(bufferedDraftHookSource).toContain(
      'restoreRejectedBufferedTerminalDraft(current, send.token.handle, send.draft)'
    )
    expect(sendSlice.match(/restoreRejectedDraft\(\)/g)).toHaveLength(2)
    expect(keyboardDismissalHookSource).toContain(
      'origin.generation === getSendCompletionGeneration()'
    )
  })

  it('keeps buffered draft callbacks scoped to terminal surfaces and prunes ended tabs', () => {
    expect(bufferedDraftHookSource).toContain('const handle = activeHandleRef.current')
    expect(bufferedDraftHookSource).toContain('invalidateBufferedTerminalDraftRestoration(')
    expect(bufferedDraftHookSource).toContain(
      'setDrafts((current) => updateBufferedTerminalDraft(current, handle, value))'
    )
    expect(bufferedDraftHookSource).toContain('pruneBufferedTerminalDraftRestorations(')
    expect(runtimeSource).toContain('useRef(bufferedTerminalDraftState.reconcileTerminalTabs)')
    expect(tabApplicationSource).toContain(
      'reconcileBufferedDraftsRef.current(currentSessionTabs, nextTabs, {'
    )
    const routeResetSlice = sourceSlice(
      startupSource,
      '// Why: Expo reuses this screen across worktrees;',
      'clearDelayedActionTimers()\n    }'
    )
    expect(routeResetSlice).toContain('bufferedTerminalDraftState.resetDrafts()')
    expect(routeResetSlice).toContain('bufferedTerminalDraftState.clearPendingRestorations()')
  })

  it('bounds buffered drafts on the terminal.list sweep, against the retained set', () => {
    // The drafts record and the pending-restoration map both live as long as the
    // session screen does; this one call is the only thing that bounds either.
    const slice = sourceSlice(
      terminalListSource,
      'const liveHandles = new Set(result.terminals.map((terminal) => terminal.handle))',
      'setTerminalKeyboardMetrics((prev) => pruneTerminalKeyboardMetrics(prev, shouldPrune))'
    )
    expect(slice).toContain('const retainedHandles = resolveRetainedTerminalHandles(pruneContext)')
    expect(slice).toContain('bufferedTerminalDraftState.pruneDrafts(retainedHandles)')
    // Not the raw list: terminal.list omits a chat-covered handle while the desktop
    // graph reloads, so sweeping drafts against it erases text the user still holds.
    expect(slice).not.toContain('pruneDrafts(liveHandles)')
    expect(slice.match(/pruneDrafts\(/g)).toHaveLength(1)
    expect(bufferedDraftHookSource).toContain(
      'setDrafts((current) => pruneBufferedTerminalDrafts(current, retainedMappedHandles))'
    )
    expect(bufferedDraftHookSource).toContain(
      'pruneBufferedTerminalDraftRestorations(pendingRestorationsRef.current, retainedMappedHandles)'
    )
  })

  it('leaves the accessory shortcut keys alone, Enter included', () => {
    // Why: the accessory bar sits on top of the keyboard — dismissing would
    // pull away the very row the user is tapping.
    const slice = sourceSlice(
      sendActionsSource,
      'async function handleAccessoryKey(',
      'const sendLiveTerminalInput = useCallback('
    )
    expect(slice).not.toContain('dismissKeyboardAfterAgentSend')
  })
})
