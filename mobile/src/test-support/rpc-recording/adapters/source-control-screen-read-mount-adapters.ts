import { hookMount, performHookAction } from '../hook-mount'
import { mountFixture } from '../recorder-fixture-shape'
import { hostClientContextExposure } from '../host-client-context-exposure'
import type { OperationExposure, operationModuleLoader } from '../operation-module-loader'
import type { MountAdapter } from '../recording-scenario'
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
          diffShowWhitespace: false,
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
        // Observe displayed diff content without coupling the recording to syntax highlighting.
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

const BRANCH_COMPARE_READY: MobileBranchCompareState = {
  kind: 'ready',
  result: mountFixture<MobileGitBranchCompareReply>({
    summary: {
      baseRef: 'origin/main',
      baseOid: 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678',
      compareRef: 'feature',
      headOid: 'f0e1d2c3b4a5968778695a4b3c2d1e0f98765432',
      mergeBase: '0123456789abcdef0123456789abcdef01234567',
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
    return {
      kind: 'ready',
      lines: preview.lines.map(({ kind, text, oldLineNumber, newLineNumber }) => ({
        kind,
        text,
        oldLineNumber,
        newLineNumber
      })),
      truncated: preview.truncated
    }
  }
  return preview.kind === 'error'
    ? { kind: 'error', message: preview.message }
    : { kind: preview.kind }
}
