import { hookMount, performHookAction } from '../hook-mount'
import { mountFixture } from '../recorder-fixture-shape'
import type { DiffComment } from '../../../../../src/shared/diff-comment-types'
import type {
  DiffNotesDelivery,
  MarkdownDocState
} from '../../../session/mobile-session-route-types'
import type { MountAdapter } from '../recording-scenario'
import type { operationModuleLoader } from '../operation-module-loader'

const WORKSPACE = 'workspace-1'
const TAB = 'tab-md'

/**
 * The session screen's own persisted text: the worktree-stored review notes, the markdown tab save,
 * and the quick-command list the terminal sheet edits.
 *
 * All three are optimistic writes with a rollback, so the projection is the local list rather than
 * the reply: what a golden has to show is which value survives a refusal. Quick commands adds a
 * serialized queue, so its recording is also the order two overlapping saves settle in.
 */
export function sessionNotesMountAdapters(
  modules: ReturnType<typeof operationModuleLoader>
): Record<string, MountAdapter> {
  return {
    'session.diff-notes': ({ client, effect }) => {
      const useComments = modules.load<
        typeof import('../../../session/use-mobile-session-diff-comments')
      >('mobile/src/session/use-mobile-session-diff-comments.ts').useMobileSessionDiffComments
      let diffComments: DiffComment[] = []
      const diffCommentsRef = { current: diffComments }
      let busy = false
      let pendingDelivery: DiffNotesDelivery | null = null
      let comments: ReturnType<typeof useComments>
      const hook = hookMount(() => {
        comments = useComments(
          mountFixture<Parameters<typeof useComments>[0]>({
            worktreeId: WORKSPACE,
            isFloatingWorkspaceRoute: false,
            client,
            connState: 'connected',
            setDiffComments: (update) => {
              diffComments = typeof update === 'function' ? update(diffComments) : update
              diffCommentsRef.current = diffComments
            },
            diffCommentsRef,
            diffCommentBusy: busy,
            setDiffCommentBusy: (update) => {
              busy = typeof update === 'function' ? update(busy) : update
            },
            setPendingDiffNotesDelivery: (update) => {
              pendingDelivery = typeof update === 'function' ? update(pendingDelivery) : update
            },
            showToast: (message: string) => effect('toast', { message })
          })
        )
      })
      return {
        action(name, args) {
          if (name === 'mount') {
            return hook.mount()
          }
          return performHookAction(() => {
            if (name === 'add') {
              return comments.addDiffCommentForFile(
                'src/app.ts',
                Number(args.line ?? 4),
                String(args.body ?? 'needs a test')
              )
            }
            if (name === 'delete') {
              return comments.deleteDiffCommentForFile(String(args.id ?? 'note-1'))
            }
            if (name === 'copy') {
              return comments.copyDiffCommentsToClipboard()
            }
            if (name === 'reload') {
              return comments.loadDiffComments()
            }
            throw new Error(`Unknown diff notes action: ${name}`)
          })
        },
        state: () => ({ diffComments, busy, pendingDelivery }),
        dispose: hook.unmount
      }
    },
    'session.markdown-save': ({ client, effect }) => {
      const useMarkdown = modules.load<
        typeof import('../../../session/use-mobile-session-markdown-actions')
      >('mobile/src/session/use-mobile-session-markdown-actions.ts').useMobileSessionMarkdownActions
      let markdownDocs = new Map<string, MarkdownDocState>([
        [
          TAB,
          {
            status: 'ready',
            content: '# a',
            localContent: '# b',
            baseVersion: 'v1',
            isDirty: true,
            editable: true
          }
        ]
      ])
      let actions: ReturnType<typeof useMarkdown>
      const hook = hookMount(() => {
        actions = useMarkdown(
          mountFixture<Parameters<typeof useMarkdown>[0]>({
            hostId: 'host-1',
            worktreeId: WORKSPACE,
            router: { push: (href: unknown) => effect('router-push', href), back: () => {} },
            client,
            sessionTabs: [{ id: TAB, type: 'markdown', relativePath: 'docs/readme.md' }],
            markdownDocs,
            setMarkdownDocs: (update) => {
              markdownDocs = typeof update === 'function' ? update(markdownDocs) : update
            },
            setDiscardMarkdownTarget: () => {},
            discardMarkdownTarget: null,
            setLeaveDrafts: () => {},
            markdownSaveSeqRef: { current: new Map() },
            markdownSaveInFlightRef: { current: new Set() },
            showToast: (message: string) => effect('toast', { message }),
            readMarkdownTab: () => {
              effect('read-markdown-tab', {})
              return Promise.resolve()
            }
          })
        )
      })
      hook.mount()
      return {
        action: (name) =>
          performHookAction(() => {
            if (name === 'save') {
              return actions.saveMarkdownTab(
                mountFixture<Parameters<typeof actions.saveMarkdownTab>[0]>({
                  type: 'markdown',
                  id: TAB,
                  relativePath: 'docs/readme.md'
                })
              )
            }
            throw new Error(`Unknown markdown action: ${name}`)
          }),
        state: () => ({ markdown: Object.fromEntries(markdownDocs) }),
        dispose: hook.unmount
      }
    },
    'settings.quick-commands': ({ client }) => {
      const useQuickCommands = modules.load<typeof import('../../../session/use-quick-commands')>(
        'mobile/src/session/use-quick-commands.ts'
      ).useQuickCommands
      let enabled = true
      let model: ReturnType<typeof useQuickCommands>
      const persisted: unknown[] = []
      const hook = hookMount(() => {
        model = useQuickCommands({ client, enabled })
      })
      return {
        action(name, args) {
          if (name === 'mount') {
            return hook.mount()
          }
          if (name === 'close') {
            enabled = false
            return hook.update()
          }
          if (name === 'persist') {
            return performHookAction(() =>
              model
                .persist({
                  type: 'upsert',
                  command: {
                    id: String(args.id ?? 'qc-1'),
                    label: String(args.label ?? 'build'),
                    command: 'pnpm build',
                    appendEnter: true
                  }
                })
                .then((value: unknown) => {
                  persisted.push(value)
                  return value
                })
            )
          }
          throw new Error(`Unknown quick command action: ${name}`)
        },
        state: () => ({
          commands: model.commands,
          loading: model.loading,
          ready: model.ready,
          error: model.error,
          persisted: [...persisted]
        }),
        dispose: hook.unmount
      }
    }
  }
}
