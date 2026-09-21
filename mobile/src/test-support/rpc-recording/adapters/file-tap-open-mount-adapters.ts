import type { MountAdapter } from '../recording-scenario'
import { mountFixture } from '../recorder-fixture-shape'
import type { operationModuleLoader } from '../operation-module-loader'

const HOST = 'host-1'
const WORKSPACE = 'workspace-1'
const TERMINAL = 'terminal-1'

/**
 * Tapping a path a terminal printed: the host resolve, then the worktree open it may lead to.
 *
 * The entry point is fire-and-forget (`void ... .catch`), so the recording observes the two sends,
 * the route it pushed and the miss callback rather than a returned value. Its three delayed
 * activation attempts run on the scenario's own clock, which is what makes the tab-switch order
 * observable at all.
 */
export function fileTapOpenMountAdapters(
  modules: ReturnType<typeof operationModuleLoader>
): Record<string, MountAdapter> {
  return {
    'files.terminal-path-tap': ({ client, effect }) => {
      const open = modules.load<typeof import('../../../session/mobile-file-tap-open')>(
        'mobile/src/session/mobile-file-tap-open.ts'
      ).openMobileFileTap
      type Tab = { id: string; relativePath?: string }
      const timers: ReturnType<typeof setTimeout>[] = []
      let sessionTabs: readonly Tab[] = []
      let activeSessionTabId: string | null = 'tab-source'
      let switched: unknown = null
      let failed = 0
      return {
        action(name, args) {
          if (name === 'list') {
            sessionTabs = [{ id: 'tab-opened', relativePath: 'src/app.ts' }]
            return sessionTabs
          }
          if (name !== 'tap') {
            throw new Error(`Unknown file tap action: ${name}`)
          }
          return open(
            mountFixture<Parameters<typeof open<Tab>>[0]>({
              client,
              hostId: HOST,
              worktreeId: WORKSPACE,
              worktreeName: 'workspace',
              terminalHandle: TERMINAL,
              pathText: String(args.pathText ?? 'src/app.ts'),
              cwd: '/repo',
              line: args.line === undefined ? null : Number(args.line),
              column: null,
              pushPreviewRoute: (href) => effect('push-preview-route', href),
              openBrowser: (url: string) => effect('open-browser', { url }),
              triggerOpenFeedback: () => effect('open-feedback', {}),
              fetchSessionTabs: () => {
                effect('fetch-session-tabs', {})
                return Promise.resolve()
              },
              getSessionTabs: () => sessionTabs,
              getActiveSessionTabId: () => activeSessionTabId,
              getActivationState: (activated: boolean) => ({
                activated,
                activationSeq: 1,
                latestActivationSeq: 1,
                sourceTerminalHandle: TERMINAL,
                activeTerminalHandle: args.moved === true ? 'terminal-2' : TERMINAL,
                activeTabType: 'terminal'
              }),
              switchSessionTab: (tab: Tab) => {
                switched = tab
                activeSessionTabId = tab.id
              },
              scheduleDelayedAction: (callback: () => void, delayMs: number) => {
                const timer = setTimeout(callback, delayMs)
                timers.push(timer)
                return timer
              },
              onOpenFailed: () => {
                failed += 1
              }
            })
          )
        },
        state: () => ({ switched, failed, activeSessionTabId }),
        dispose: () => {
          for (const timer of timers) {
            clearTimeout(timer)
          }
        }
      }
    }
  }
}
