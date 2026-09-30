import { createElement } from 'react'
import { hookMount, performHookAction } from '../hook-mount'
import { projectMountedScreen, renderedElementProps, screenMount } from '../mounted-screen-tree'
import { mountFixture } from '../recorder-fixture-shape'
import { hostClientContextExposure, loadHostClientContext } from '../host-client-context-exposure'
import type { OperationExposure, operationModuleLoader } from '../operation-module-loader'
import type { MountAdapter } from '../recording-scenario'
import type { RpcClientContextValue } from '../../../transport/rpc-client-context-contract'
import type {
  MobileBranchCompareState,
  MobileBranchDiffPreviewState
} from '../../../source-control/mobile-source-control-screen-state'
import type {
  MobileGitBranchChangeEntry,
  MobileGitBranchCompareReply
} from '../../../source-control/git-compare-reply-schema'

const HOST = 'host-1'
const WORKTREE = 'repo42::/p'

/** The commit list reads its reconnect handle through the context `client-context.tsx` keeps. */
export const sourceControlScreenReadMountExposures: readonly OperationExposure[] = [
  hostClientContextExposure
]

/**
 * The four source-control reads whose replies no other adapter observes: the Changes screen's
 * status and branch compare, the history list's per-commit file list, and the committed-diff
 * preview. Each is mounted through the hook or screen that owns it rather than through the sender,
 * because the reply these operations return is only visible in what the owner then publishes.
 */
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
      // Stable across renders: the hook's mount effect keys on the callbacks it was handed, so a
      // fresh closure per render would re-send the status load and hide the settled state.
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
        // The branch compare is loaded by the status load, not by an action, so both states are
        // projected together: a status reply the reader rejects never reaches the compare at all.
        state: () => ({
          screenState: loaders?.screenState ?? 'unmounted',
          branchCompareState: loaders?.branchCompareState ?? 'unmounted'
        }),
        dispose: hook.unmount
      }
    },
    'source-control.history-commit-files': ({ client, effect }) => {
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
              bottomInset: 34
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
          if (name === 'expand') {
            // An inert FlatList never calls `renderItem`, so expanding a commit means rendering one
            // row through the screen's own callback and calling the handler it put on it.
            return performHookAction(() => pressFirstCommit(screen.tree()))
          }
          throw new Error(`Unknown history commit action: ${name}`)
        },
        state: () => ({
          ...projectMountedScreen(screen),
          // The commit-compare reply is only ever drawn inside a row, so the row is rendered
          // through the screen's own callback and read back. Without it the file list is
          // unobservable and the operation has no oracle.
          commitRow: projectFirstCommitRow(screen.tree())
        }),
        dispose: screen.unmount
      }
    },
    'source-control.branch-diff-preview': ({ client, effect }) => {
      const useOpeners = modules.load<
        typeof import('../../../source-control/use-mobile-source-control-openers')
      >(
        'mobile/src/source-control/use-mobile-source-control-openers.ts'
      ).useMobileSourceControlOpeners
      const mountedRef = { current: true }
      const busyActionRef: { current: string | null } = { current: null }
      let openers: ReturnType<typeof useOpeners>
      const hook = hookMount(() => {
        openers = useOpeners({
          client,
          connState: 'connected',
          hostId: HOST,
          worktreeId: WORKTREE,
          name: 'orca',
          // Only the session origin previews in place; any other pushes a route instead.
          origin: 'session',
          embedded: true,
          branchCompareState: BRANCH_COMPARE_READY,
          mountedRef,
          busyActionRef,
          setActionError: (message) => effect('source-control.action-error', { message })
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
          if (name === 'open') {
            return performHookAction(() => openers.openBranchDiff(BRANCH_ENTRY))
          }
          throw new Error(`Unknown branch diff action: ${name}`)
        },
        // The highlighted lines are a rendering of the diff, not an observation of the reply, so the
        // preview is projected by what it is and how much it carried.
        state: () => ({ preview: projectBranchDiffPreview(openers?.branchDiffPreview) }),
        dispose: hook.unmount
      }
    }
  }
}

const BRANCH_ENTRY = mountFixture<MobileGitBranchChangeEntry>({
  path: 'src/app.ts',
  status: 'modified',
  added: 2,
  removed: 1
})

/** A compare the screen has already loaded, which is the precondition the diff open guards on. */
const BRANCH_COMPARE_READY: MobileBranchCompareState = {
  kind: 'ready',
  result: mountFixture<MobileGitBranchCompareReply>({
    summary: {
      baseRef: 'origin/main',
      baseOid: 'base-oid',
      compareRef: 'feature',
      headOid: 'head-oid',
      mergeBase: 'merge-base',
      changedFiles: 1,
      status: 'ready'
    },
    entries: [BRANCH_ENTRY]
  })
}

function projectBranchDiffPreview(preview: MobileBranchDiffPreviewState | null): unknown {
  if (!preview) {
    return 'unopened'
  }
  if (preview.kind === 'ready') {
    return { kind: 'ready', lines: preview.lines.length, truncated: preview.truncated }
  }
  return preview.kind === 'error'
    ? { kind: 'error', message: preview.message }
    : { kind: preview.kind }
}

type RenderedRow = { props?: { onPress?: () => void; children?: unknown } }
type CommitList = { data?: unknown; renderItem?: (row: { item: unknown }) => unknown }

/** The copy the first commit row carries, which is where an expanded commit's files are drawn. */
function projectFirstCommitRow(tree: unknown): unknown {
  const row = renderFirstCommit(tree)
  if (!row) {
    return 'unrendered'
  }
  const text: string[] = []
  collectElementText(row, text)
  return text
}

/** The first commit row the list rendered, pressed through the handler the screen gave it. */
function pressFirstCommit(tree: unknown): void {
  const press = findPressHandler(renderFirstCommit(tree))
  if (!press) {
    throw new Error('The history list rendered no commit to expand')
  }
  press()
}

/**
 * One row, built by the list's own `renderItem`. An inert FlatList never calls it, so this is the
 * only way either to reach a row's handler or to read what it drew.
 */
function renderFirstCommit(tree: unknown): unknown {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: both members are read back optionally and guarded below; FlatList props are whatever the screen passed.
  const list = renderedElementProps(tree, 'FlatList')[0] as CommitList | undefined
  const rows = Array.isArray(list?.data) ? list.data : []
  const render = list?.renderItem
  return typeof render === 'function' && rows.length > 0 ? render({ item: rows[0] }) : null
}

/** The strings an unmounted element tree would draw, in render order. */
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

/** First `onPress` in a rendered-but-unmounted element, depth first. */
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
