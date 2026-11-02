import { createElement } from 'react'
import { hookMount, performHookAction } from '../hook-mount'
import { projectMountedScreen, renderedElementProps, screenMount } from '../mounted-screen-tree'
import { mountFixture } from '../recorder-fixture-shape'
import { hostClientContextExposure, loadHostClientContext } from '../host-client-context-exposure'
import type { OperationExposure, operationModuleLoader } from '../operation-module-loader'
import type { MountAdapter } from '../recording-scenario'
import type { RpcClientContextValue } from '../../../transport/rpc-client-context-contract'

const HOST = 'host-1'
const WORKTREE = 'repo42::/p'

export const sourceControlScreenReadMountExposures: readonly OperationExposure[] = [
  hostClientContextExposure
]

// Mount reply owners so recordings observe published state rather than sender return values.
export function sourceControlScreenReadMountAdapters(
  modules: ReturnType<typeof operationModuleLoader>
): Record<string, MountAdapter> {
  return {
    'source-control.changes-load': ({ client, effect }) => {
      const useLoaders = modules.load<
        typeof import('../../../source-control/use-mobile-source-control-loaders')
      >(
        'mobile/src/source-control/use-mobile-source-control-loaders.ts'
      ).useMobileSourceControlLoaders
      let loaders: ReturnType<typeof useLoaders>
      // Keep callbacks stable; new identities would retrigger status loading and hide settled state.
      const reportActionError = (message: string | null): void =>
        effect('source-control.action-error', { message })
      const reportStatusLoadSuccess = (): void => effect('source-control.status-load-success', {})
      const hook = hookMount(() => {
        loaders = useLoaders({
          client,
          connState: 'connected',
          statusIdentityKey: `${HOST}:${WORKTREE}`,
          worktreeId: WORKTREE,
          setActionError: reportActionError,
          onStatusLoadSuccess: reportStatusLoadSuccess
        })
      })
      return {
        action(name) {
          if (name === 'mount' || name === 'remount') {
            return hook.mount()
          }
          if (name === 'unmount') {
            return hook.unmount()
          }
          if (name === 'load') {
            return performHookAction(() => loaders.loadStatus())
          }
          throw new Error(`Unknown changes load action: ${name}`)
        },
        // Project status and compare together because a refused status read prevents the compare load.
        state: () => ({
          screenState: loaders?.screenState ?? 'unmounted',
          branchCompareState: loaders?.branchCompareState ?? 'unmounted'
        }),
        dispose: hook.unmount
      }
    },
    'source-control.history-branch-commits': ({ client, effect }) => {
      const List = modules.load<typeof import('../../../source-control/MobileGitHistoryList')>(
        'mobile/src/source-control/MobileGitHistoryList.tsx'
      ).MobileGitHistoryList
      const hostClientContext = loadHostClientContext(modules)
      const context = mountFixture<RpcClientContextValue>({
        acquire: () => client,
        release: () => {},
        getAllClients: () => [{ hostId: HOST, client }],
        subscribeHostState: () => () => {},
        forceReconnect: (hostId) => {
          effect('host-client.force-reconnect', { hostId })
          return Promise.resolve()
        }
      })
      const screen = screenMount(
        () =>
          createElement(
            hostClientContext.Provider,
            { value: context },
            createElement(List, {
              client,
              connState: 'connected',
              worktreeId: WORKTREE,
              hostId: HOST,
              bottomInset: 34,
              onOpenCommit: (commit: { id: string }) =>
                effect('history.open-commit', { id: commit.id })
            })
          ),
        effect
      )
      return {
        action(name) {
          if (name === 'mount' || name === 'remount') {
            return screen.mount()
          }
          if (name === 'unmount') {
            return screen.unmount()
          }
          if (name === 'open') {
            // The inert FlatList never renders rows; invoke the handler from the screen’s own renderItem.
            return performHookAction(() => pressFirstCommit(screen.tree()))
          }
          throw new Error(`Unknown history action: ${name}`)
        },
        state: () => ({
          ...projectMountedScreen(screen),
          // Render the first commit row to observe its timeline, stats and copy.
          commitRow: projectFirstCommitRow(screen.tree())
        }),
        dispose: screen.unmount
      }
    }
  }
}

type RenderedRow = { props?: { onPress?: () => void; children?: unknown } }
type CommitList = { data?: unknown; renderItem?: (row: { item: unknown }) => unknown }

function projectFirstCommitRow(tree: unknown): unknown {
  const row = renderFirstCommit(tree)
  if (!row) {
    return 'unrendered'
  }
  const text: string[] = []
  collectElementText(row, text)
  return text
}

function pressFirstCommit(tree: unknown): void {
  const press = findPressHandler(renderFirstCommit(tree))
  if (!press) {
    throw new Error('The history list rendered no commit to open')
  }
  press()
}

// The inert FlatList never calls renderItem; build the row to read its copy or invoke its handler.
function renderFirstCommit(tree: unknown): unknown {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: both members are read back optionally and guarded below; FlatList props are whatever the screen passed.
  const list = renderedElementProps(tree, 'FlatList')[0] as CommitList | undefined
  const rows: unknown[] = Array.isArray(list?.data) ? list.data : []
  // Section headers share the list; the first commit row is the first item of kind commit.
  const commit = rows.find(
    (row) => typeof row === 'object' && row !== null && 'kind' in row && row.kind === 'commit'
  )
  const render = list?.renderItem
  return typeof render === 'function' && commit !== undefined ? render({ item: commit }) : null
}

function collectElementText(node: unknown, text: string[]): void {
  if (typeof node === 'string') {
    text.push(node)
    return
  }
  if (typeof node === 'number') {
    text.push(String(node))
    return
  }
  if (Array.isArray(node)) {
    for (const child of node) {
      collectElementText(child, text)
    }
    return
  }
  if (!node || typeof node !== 'object' || !('props' in node)) {
    return
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: a React element's children are read back optionally and every shape is handled above.
  collectElementText((node as RenderedRow).props?.children, text)
}

function findPressHandler(node: unknown): (() => void) | null {
  if (Array.isArray(node)) {
    for (const child of node) {
      const found = findPressHandler(child)
      if (found) {
        return found
      }
    }
    return null
  }
  if (!node || typeof node !== 'object' || !('props' in node)) {
    return null
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: a React element's props are read back optionally and the handler is typeof-checked.
  const element = node as RenderedRow
  return typeof element.props?.onPress === 'function'
    ? element.props.onPress
    : findPressHandler(element.props?.children)
}
