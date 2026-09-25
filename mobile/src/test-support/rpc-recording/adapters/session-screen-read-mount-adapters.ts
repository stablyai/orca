import { hookMount, performHookAction } from '../hook-mount'
import type {
  FileDocState,
  MarkdownDocState,
  MobileSessionTab
} from '../../../session/mobile-session-route-types'
import type { TerminalRecord } from '../../../session/mobile-terminal-records'
import { mountFixture } from '../recorder-fixture-shape'
import type { MountAdapter } from '../recording-scenario'
import type { operationModuleLoader } from '../operation-module-loader'

const WORKSPACE = 'workspace-1'
const HANDLE = 'terminal-1'
const DEVICE_TOKEN = 'device-token-1'

/**
 * What the session screen reads while it is open: a markdown or file tab's document, the terminal
 * inventory, the repo probe native chat gates readability on, and the paced double-Escape stop.
 *
 * These hooks take the screen's accumulated model, so each mount supplies only the members the hook
 * destructures — a fixture completed into a whole session model would invent state no scenario
 * observes. The setters are recorded as model values rather than as native UI.
 */
export function sessionScreenReadMountAdapters(
  modules: ReturnType<typeof operationModuleLoader>
): Record<string, MountAdapter> {
  return {
    'session.tab-documents': ({ client }) => {
      const useReaders = modules.load<
        typeof import('../../../session/use-mobile-session-document-readers')
      >('mobile/src/session/use-mobile-session-document-readers.ts').useMobileSessionDocumentReaders
      let markdownDocs = new Map<string, MarkdownDocState>()
      let fileDocs = new Map<string, FileDocState>()
      let readers: ReturnType<typeof useReaders>
      const hook = hookMount(() => {
        readers = useReaders(
          mountFixture<Parameters<typeof useReaders>[0]>({
            worktreeId: WORKSPACE,
            client,
            setMarkdownDocs: (update) => {
              markdownDocs = typeof update === 'function' ? update(markdownDocs) : update
            },
            setFileDocs: (update) => {
              fileDocs = typeof update === 'function' ? update(fileDocs) : update
            }
          })
        )
      })
      hook.mount()
      return {
        action(name, args) {
          if (name === 'markdown') {
            return performHookAction(() =>
              readers.readMarkdownTab(
                mountFixture<Parameters<typeof readers.readMarkdownTab>[0]>({
                  type: 'markdown',
                  id: 'tab-md',
                  relativePath: 'docs/readme.md',
                  isDirty: args.dirty === true
                })
              )
            )
          }
          if (name === 'file') {
            return performHookAction(() =>
              readers.readFileTab(
                mountFixture<Parameters<typeof readers.readFileTab>[0]>({
                  type: 'file',
                  id: 'tab-file',
                  relativePath: 'src/app.ts',
                  ...(args.diff === true ? { diffSource: 'staged' as const } : {})
                })
              )
            )
          }
          throw new Error(`Unknown document action: ${name}`)
        },
        state: () => ({
          markdown: Object.fromEntries(markdownDocs),
          file: Object.fromEntries(fileDocs)
        }),
        dispose: hook.unmount
      }
    },
    'session.terminal-inventory': ({ client, effect }) => {
      const useList = modules.load<
        typeof import('../../../session/use-mobile-session-terminal-list')
      >('mobile/src/session/use-mobile-session-terminal-list.ts').useMobileSessionTerminalList
      let terminals: TerminalRecord[] = []
      const terminalsRef: { current: TerminalRecord[] } = { current: [] }
      const sessionTabsRef: { current: MobileSessionTab[] } = { current: [] }
      const unsubs = new Map<string, () => void>([[HANDLE, () => {}]])
      let listModel: ReturnType<typeof useList>
      const hook = hookMount(() => {
        listModel = useList(
          mountFixture<Parameters<typeof useList>[0]>({
            hostId: 'host-1',
            worktreeId: WORKSPACE,
            client,
            setTerminals: (update) => {
              terminals = typeof update === 'function' ? update(terminals) : update
            },
            terminalsRef,
            sessionTabsRef,
            pruneTerminalHandlesFromLiveInput: (handles) =>
              effect('prune-live-input', [...handles]),
            defaultTerminalHandlesToLiveInput: (handles) =>
              effect('default-live-input', [...handles]),
            clearTerminalLiveInputDefault: (handle) => effect('clear-live-input', { handle }),
            setTerminalKeyboardMetrics: () => {},
            terminalRefs: { current: new Map() },
            terminalUnsubsRef: { current: unsubs },
            initializedHandlesRef: { current: new Set([HANDLE]) },
            viewportResubscribeBudgetRef: {
              current: {
                forget: (handle: string) => effect('forget-viewport-budget', { handle }),
                notifyListedHandles: () => {}
              }
            },
            activeHandleRef: { current: HANDLE },
            showNativeChatRef: { current: false },
            unsubscribeTerminal: (handle: string) => effect('unsubscribe-terminal', { handle }),
            nativeChatStream: { notifyListedHandles: () => {} },
            bufferedTerminalDraftState: { pruneDrafts: () => {} }
          })
        )
      })
      hook.mount()
      return {
        action: (name) =>
          performHookAction(() =>
            listModel.fetchTerminals(name === 'no-empty' ? { allowEmptyLoaded: false } : {})
          ),
        state: () => ({ terminals, known: terminalsRef.current }),
        dispose: hook.unmount
      }
    },
    'session.native-chat-readability': ({ client }) => {
      const useReadability = modules.load<
        typeof import('../../../session/use-mobile-native-chat-readability')
      >('mobile/src/session/use-mobile-native-chat-readability.ts').useMobileNativeChatReadability
      let readable = false
      let worktreeId = `repo-1::/w`
      const hook = hookMount(() => {
        readable = useReadability(client, worktreeId)
      })
      return {
        action(name) {
          if (name === 'mount') {
            return hook.mount()
          }
          if (name === 'reroute') {
            worktreeId = 'repo-2::/w'
            return hook.update()
          }
          throw new Error(`Unknown readability action: ${name}`)
        },
        state: () => ({ readable, worktreeId }),
        dispose: hook.unmount
      }
    },
    'session.native-chat-stop': ({ client, effect }) => {
      const useStop = modules.load<typeof import('../../../session/use-mobile-native-chat-stop')>(
        'mobile/src/session/use-mobile-native-chat-stop.ts'
      ).useMobileNativeChatStop
      const errors: string[] = []
      let stop: () => void
      let enabled = true
      const hook = hookMount(() => {
        stop = useStop(
          mountFixture<Parameters<typeof useStop>[0]>({
            client,
            enabled,
            handleRef: { current: HANDLE },
            deviceTokenRef: { current: DEVICE_TOKEN },
            streamIdentity: 'stream-1',
            cancelPending: () => effect('cancel-pending', {}),
            onSendError: (message: string) => errors.push(message)
          })
        )
      })
      hook.mount()
      return {
        action(name) {
          if (name === 'stop') {
            return performHookAction(() => stop())
          }
          if (name === 'leave') {
            enabled = false
            return hook.update()
          }
          throw new Error(`Unknown stop action: ${name}`)
        },
        state: () => ({ errors: [...errors] }),
        dispose: hook.unmount
      }
    }
  }
}
