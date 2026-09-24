import { hookScreenMount } from '../mounted-screen-tree'
import { mountFixture } from '../recorder-fixture-shape'
import type { operationModuleLoader } from '../operation-module-loader'
import type { MountAdapter, MountContext } from '../recording-scenario'
import type { TerminalModes } from '../../../terminal/terminal-webview-contract'

const HANDLE = 'terminal-1'
const DEVICE_TOKEN = 'device-token-1'
const WORKTREE = 'repo-a::/tmp/repo-a'
/** Bracketed paste is on and the alt screen is off, which is what wraps a pasted payload. */
const PTY_MODES: TerminalModes = {
  bracketedPasteMode: true,
  altScreen: false,
  mouseTrackingMode: 'none',
  sgrMouseMode: false,
  sgrMousePixelsMode: false
}

/**
 * What the session screen's terminal input surface puts on the wire: the composed draft send, the
 * live keystroke send, the clipboard paste that rides on the same method, and the repo read that
 * resolves which connection a workspace's terminal lives on.
 *
 * The device state these hooks read is real rather than declared. The pasteboard is the engine's
 * per-recording fixture, so the bytes a paste reads are the bytes a recorded copy put there one
 * action earlier — the same sequence a phone performs. The draft store is the product's own
 * `useBufferedTerminalDrafts`, mounted in the same tree, so the text a send clears and a refusal
 * restores is state the recording drove rather than a stand-in.
 *
 * Only the clipboard's text path is driven. Its image path decodes a raster through
 * expo-image-manipulator and stages it on expo-file-system, and neither module is substituted:
 * recording it would mean inventing image and file-system behaviour, which is not what this oracle
 * is evidence of. The send both paths reach is the same expression, and the text path reaches it.
 *
 * Mounted through `hookScreenMount` for its crash boundary: a reply partition that takes a hook's
 * effect down is the recording, not a suite failure.
 */
export function sessionTerminalInputMountAdapters(
  modules: ReturnType<typeof operationModuleLoader>
): Record<string, MountAdapter> {
  return {
    'session.terminal-clipboard': (context) => mountTerminalClipboard(modules, context),
    'session.terminal-input-send': (context) => mountTerminalInputSend(modules, context)
  }
}

function mountTerminalClipboard(
  modules: ReturnType<typeof operationModuleLoader>,
  { client, effect }: MountContext
) {
  const useAccessorySelection = modules.load<
    typeof import('../../../session/use-mobile-session-accessory-selection')
  >(
    'mobile/src/session/use-mobile-session-accessory-selection.ts'
  ).useMobileSessionAccessorySelection
  const useTerminalPaste = modules.load<
    typeof import('../../../session/use-mobile-terminal-paste')
  >('mobile/src/session/use-mobile-terminal-paste.ts').useMobileTerminalPaste
  const takeover = modules.load<typeof import('../../../terminal/worker-terminal-takeover-report')>(
    'mobile/src/terminal/worker-terminal-takeover-report.ts'
  )
  // The per-client report window is module state; a fresh recording must not inherit one.
  takeover.resetWorkerTerminalTakeoverReportsForTest()

  const ptyModesRef = { current: new Map([[HANDLE, PTY_MODES]]) }
  let selection: ReturnType<typeof useAccessorySelection> | undefined
  let paste: ReturnType<typeof useTerminalPaste> | undefined
  let connectionId: unknown = 'unresolved'
  let pasteOutcome: unknown = 'unpasted'

  const screen = hookScreenMount(() => {
    const model = useAccessorySelection(
      mountFixture<Parameters<typeof useAccessorySelection>[0]>({
        client,
        connState: 'connected',
        worktreeId: WORKTREE,
        isFloatingWorkspaceRoute: false,
        activeHandleRef: { current: HANDLE },
        terminalRefs: { current: new Map() },
        ptyModesRef,
        setCanPaste: (value) => effect('can-paste', { value }),
        setSelectModeActive: (value) => effect('select-mode', { value }),
        showToast: (message: string, durationMs?: number) =>
          effect('toast', { message, durationMs: durationMs ?? null })
      })
    )
    selection = model
    paste = useTerminalPaste(
      mountFixture<Parameters<typeof useTerminalPaste>[0]>({
        activeHandle: HANDLE,
        activeHandleRef: { current: HANDLE },
        activeSessionTabTypeRef: { current: 'terminal' },
        canSend: true,
        client,
        clientRef: { current: client },
        connState: 'connected',
        connStateRef: { current: 'connected' },
        deviceTokenRef: { current: DEVICE_TOKEN },
        flushPendingLiveInputBeforeExternalSend: (handle: string) => {
          effect('flush-live-input', { handle })
          return Promise.resolve(true)
        },
        getActiveWorktreeConnectionId: () => model.getActiveWorktreeConnectionId(),
        onError: () => {
          pasteOutcome = 'error'
        },
        onSuccess: () => {
          pasteOutcome = 'sent'
        },
        ptyModesRef,
        refreshCanPaste: () => effect('refresh-can-paste', {}),
        showToast: (message: string, durationMs?: number) =>
          effect('toast', { message, durationMs: durationMs ?? null })
      })
    )
  }, effect)

  return {
    action(name: string, args: Record<string, unknown>) {
      if (name === 'mount') {
        return screen.mount()
      }
      if (name === 'copy') {
        return selection!.handleSelectionCopy(HANDLE, String(args.text ?? 'echo hi'))
      }
      if (name === 'paste') {
        return paste!()
      }
      if (name === 'connection') {
        return selection!.getActiveWorktreeConnectionId().then(
          (value: unknown) => {
            connectionId = value
            return value
          },
          (error: unknown) => {
            connectionId = error instanceof Error ? error.message : String(error)
            throw error
          }
        )
      }
      throw new Error(`Unknown terminal clipboard action: ${name}`)
    },
    state: () => ({ connectionId, pasteOutcome, crash: screen.crash() }),
    dispose: () => {
      takeover.resetWorkerTerminalTakeoverReportsForTest()
      screen.unmount()
    }
  }
}

function mountTerminalInputSend(
  modules: ReturnType<typeof operationModuleLoader>,
  { client, effect }: MountContext
) {
  const useSendActions = modules.load<
    typeof import('../../../session/use-mobile-session-terminal-send-actions')
  >(
    'mobile/src/session/use-mobile-session-terminal-send-actions.ts'
  ).useMobileSessionTerminalSendActions
  const useDrafts = modules.load<typeof import('../../../terminal/use-buffered-terminal-drafts')>(
    'mobile/src/terminal/use-buffered-terminal-drafts.ts'
  ).useBufferedTerminalDrafts
  const takeover = modules.load<typeof import('../../../terminal/worker-terminal-takeover-report')>(
    'mobile/src/terminal/worker-terminal-takeover-report.ts'
  )
  takeover.resetWorkerTerminalTakeoverReportsForTest()

  const activeHandleRef = { current: HANDLE }
  const sendingRef = { current: false }
  // An agent tab, so an accepted send hands the turn over and the keyboard drop is observable.
  const activeSessionTab = {
    type: 'terminal' as const,
    id: 'tab-1',
    title: 'claude',
    terminal: HANDLE,
    launchAgent: 'claude' as const,
    isActive: true
  }
  let drafts: ReturnType<typeof useDrafts> | undefined
  let actions: ReturnType<typeof useSendActions> | undefined
  let liveAccepted: unknown = 'unsent'

  const screen = hookScreenMount(() => {
    const draftState = useDrafts({ activeHandle: HANDLE, activeHandleRef })
    drafts = draftState
    actions = useSendActions(
      mountFixture<Parameters<typeof useSendActions>[0]>({
        client,
        activeHandle: HANDLE,
        activeSessionTab,
        canSend: true,
        keyboardHeight: 0,
        deviceTokenRef: { current: DEVICE_TOKEN },
        clientRef: { current: client },
        connStateRef: { current: 'connected' },
        liveInputRef: { current: null },
        commandInputRef: { current: null },
        liveInputFocusTimerRef: { current: null },
        sendLiveTerminalInputRef: { current: null },
        sessionTabActionSheetKeyboardHideSubRef: { current: null },
        sessionTabActionSheetRequestSeqRef: { current: 0 },
        activeHandleRef,
        activeSessionTabTypeRef: { current: 'terminal' },
        sendingRef,
        bufferedTerminalDraftState: draftState,
        getSendCompletionGeneration: () => 0,
        showToast: (message: string, durationMs?: number) =>
          effect('toast', { message, durationMs: durationMs ?? null })
      })
    )
  }, effect)

  return {
    action(name: string, args: Record<string, unknown>) {
      if (name === 'mount') {
        return screen.mount()
      }
      if (name === 'type') {
        drafts!.setInput(String(args.text ?? 'ls -la'))
        return screen.update()
      }
      if (name === 'send') {
        return actions!.handleSend()
      }
      if (name === 'live') {
        return actions!
          .sendLiveTerminalInput(HANDLE, String(args.bytes ?? 'ls'))
          .then((value: unknown) => {
            liveAccepted = value
            return value
          })
      }
      throw new Error(`Unknown terminal input send action: ${name}`)
    },
    state: () => ({
      input: drafts?.input ?? null,
      sending: sendingRef.current,
      liveAccepted,
      crash: screen.crash()
    }),
    dispose: () => {
      takeover.resetWorkerTerminalTakeoverReportsForTest()
      screen.unmount()
    }
  }
}
