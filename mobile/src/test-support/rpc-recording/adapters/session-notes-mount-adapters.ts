import type * as UseMobileSessionMarkdownActionsModule from '../../../files/session-documents/use-mobile-session-markdown-actions'
import type * as UseQuickCommandsModule from '../../../terminal/quick-commands/use-quick-commands'
import { hookMount, performHookAction } from '../hook-mount'
import { mountFixture } from '../recorder-fixture-shape'
import type { MarkdownDocState } from '../../../files/session-documents/session-document-state'
import type { MountAdapter } from '../recording-scenario'
import type { operationModuleLoader } from '../operation-module-loader'

const WORKSPACE = 'workspace-1'
const TAB = 'tab-md'

// Observe local values surviving refused optimistic saves and settlement order for overlapping serialized quick-command writes.
export function sessionNotesMountAdapters(
  modules: ReturnType<typeof operationModuleLoader>
): Record<string, MountAdapter> {
  return {
    'session.markdown-save': ({ client, effect }) => {
      const useMarkdown = modules.load<typeof UseMobileSessionMarkdownActionsModule>(
        'mobile/src/files/session-documents/use-mobile-session-markdown-actions.ts'
      ).useMobileSessionMarkdownActions
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
            },
            dictationLeaveHold: { holdsLeave: false, hold: () => false }
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
      const useQuickCommands = modules.load<typeof UseQuickCommandsModule>(
        'mobile/src/terminal/quick-commands/use-quick-commands.ts'
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
