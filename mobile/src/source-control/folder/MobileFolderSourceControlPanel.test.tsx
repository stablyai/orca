import { createElement, type ReactNode } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { FolderListRow } from './mobile-folder-attached-worktrees'

const seen = vi.hoisted(() => {
  const state: { covered: boolean; membersObserving: boolean[]; rowsSubscribed: boolean[] } = {
    covered: false,
    membersObserving: [],
    rowsSubscribed: []
  }
  return state
})
vi.mock('react-native', () => ({ ScrollView: 'ScrollView', View: 'View' }))
vi.mock('lucide-react-native', () => ({ GitBranch: 'GitBranch' }))
vi.mock('expo-router', () => ({ useFocusEffect: () => {} }))
vi.mock('react-native-safe-area-context', () => ({
  SafeAreaView: 'SafeAreaView',
  useSafeAreaInsets: () => ({ bottom: 0 })
}))
vi.mock('../../components/MobileStateView', () => ({
  MobileLoadErrorState: 'MobileLoadErrorState',
  MobileOfflineState: 'MobileOfflineState',
  MobileStateView: 'MobileStateView'
}))
vi.mock('../../transport/connection/connection-retry-action', () => ({
  connectionRetryAction: () => () => {}
}))
vi.mock('../../transport/connection/host-client-hooks', () => ({
  useForceReconnect: () => () => {}
}))
vi.mock('../../components/bottom-drawer/BottomDrawer', () => ({
  OptionPager: ({ main }: { main: ReactNode }) => main,
  useOptionPager: () => ({ page: null, open: () => {}, close: () => {} })
}))
vi.mock('../../components/list/ListGroup', () => ({ ListGroup: 'ListGroup' }))
vi.mock('../../i18n/use-mobile-translation', () => ({
  useMobileTranslation: () => (_key: string, fallback: string) => fallback
}))
vi.mock('../../navigation/use-back-claim', () => ({ useBackClaim: () => {} }))
vi.mock('../../navigation/workspace-route-handoff', () => ({
  useWorkspaceRouteHandoff: () => ({ back: () => {} })
}))
vi.mock('../../navigation/workspace-route', () => ({
  WorkspaceExecutionScope: 'WorkspaceExecutionScope'
}))
vi.mock('../../theme/mobile-theme', () => ({ colors: {}, spacing: { lg: 16 } }))
vi.mock('../../theme/themed-styles', () => ({
  themedStyleSheet: (styles: () => unknown) => styles()
}))
vi.mock('../../theme/use-mobile-color-scheme', () => ({ useMobileColorScheme: () => {} }))
vi.mock('../MobileSourceControlHeader', () => ({
  MobileSourceControlHeader: 'MobileSourceControlHeader'
}))
vi.mock('../MobileSourceControlPanel', () => ({ MobileSourceControlPanel: 'Panel' }))
vi.mock('../mobile-source-control-styles', () => ({ styles: {} }))
vi.mock('./MobileFolderEmptyState', () => ({ MobileFolderEmptyState: 'EmptyState' }))
vi.mock('../../components/host-protocol-gates-context', () => ({
  useOptionalHostProtocolGates: () => null
}))
vi.mock('./use-folder-create-flow', () => ({
  useFolderCreateFlow: () => ({
    onCreate: async () => {},
    covered: seen.covered,
    composerElement: null,
    toastElement: null
  })
}))
vi.mock('./MobileFolderWorktreeRow', () => ({
  MobileFolderWorktreeRow: (props: { subscribed: boolean }) => {
    seen.rowsSubscribed.push(props.subscribed)
    return null
  }
}))
vi.mock('./use-mobile-folder-attached-worktrees', () => ({
  useMobileFolderAttachedWorktrees: (_hostId: string, _folderId: string, observing: boolean) => {
    seen.membersObserving.push(observing)
    return {
      folder: { worktreeId: 'folder:f-1', repoId: 'folder-workspace:f-1', displayName: 'payments' },
      worktrees: [ROW],
      desktopCapabilities: [],
      serverHosts: [],
      connState: 'connected',
      loadError: null,
      refetch: () => {}
    }
  }
}))

import { MobileFolderSourceControlPanel } from './MobileFolderSourceControlPanel'

const ROW: FolderListRow = {
  worktreeId: 'repo-1::/w/payments',
  repoId: 'repo-1',
  repo: 'orca',
  displayName: 'payments',
  branch: 'payments'
}

let renderer: ReactTestRenderer | null = null
afterEach(() => {
  act(() => renderer?.unmount())
  renderer = null
  seen.covered = false
  seen.membersObserving = []
  seen.rowsSubscribed = []
})

describe('MobileFolderSourceControlPanel', () => {
  it('pauses row status under the create form while the folder members stay live', () => {
    seen.covered = true
    act(() => {
      renderer = create(
        createElement(MobileFolderSourceControlPanel, {
          hostId: 'host-1',
          folderWorktreeId: 'folder:f-1',
          name: 'payments',
          embedded: true
        })
      )
    })

    expect(seen.rowsSubscribed.at(-1)).toBe(false)
    expect(seen.membersObserving.at(-1)).toBe(true)
  })
})
