import { act } from 'react-test-renderer'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ExecutionHostId } from '../../../../../src/shared/execution-host/execution-host'
import { FakeSession } from '../../../transport/connection/mobile-endpoint-supervisor-test-fakes'
import {
  hookMount,
  settleQueryNotifications
} from '../../../test-support/rpc-recording/react-mounting/hook-mount'
import type { MobileWorkspaceRepo } from '../forms/new-worktree-modal-types'
import { useNewWorkspaceRepositories } from './use-new-workspace-repositories'

vi.mock('react-native', () => ({ AppState: {} }))
const servers = vi.hoisted(() => {
  const state: { repos: ReadonlyMap<string, unknown[]> } = { repos: new Map() }
  return state
})
vi.mock('../../../worktree/repositories/use-server-repos', () => ({
  useServerRepos: () => servers.repos
}))
vi.mock('../../../worktree/navigation/use-last-visited-worktree-repo', () => ({
  useLastVisitedWorktreeRepoId: () => ({ loaded: true, repoId: 'api' })
}))

const SERVER: ExecutionHostId = 'runtime:env-1'
const repo = (executionHostId?: ExecutionHostId): MobileWorkspaceRepo => ({
  id: 'api',
  displayName: 'api',
  path: '/src/api',
  kind: 'git',
  ...(executionHostId ? { executionHostId } : {})
})

function desktopListing(repos: MobileWorkspaceRepo[]) {
  const client = new FakeSession('connected')
  client.sendRequest.mockResolvedValue({
    id: '1',
    ok: true,
    result: { repos },
    _meta: { runtimeId: 'r' }
  })
  return client
}

let mounted: ReturnType<typeof hookMount> | null = null
afterEach(async () => {
  await mounted?.unmount()
  mounted = null
  servers.repos = new Map()
})

describe('useNewWorkspaceRepositories initial repo', () => {
  it('picks the named host’s copy of a repo id two hosts share', async () => {
    const client = desktopListing([repo()])
    let picked: MobileWorkspaceRepo | null = null
    mounted = hookMount(() => {
      picked = useNewWorkspaceRepositories({
        client,
        hostId: 'host-1',
        visible: true,
        initialRepo: { id: 'api', executionHostId: SERVER }
      }).selectedRepo
    })
    mounted.mount()
    await settleQueryNotifications()
    // The desktop's same-id repo must not stand in while the server's listing is on its way.
    expect(picked).toBeNull()

    servers.repos = new Map([[SERVER, [repo(SERVER)]]])
    act(() => mounted?.update())
    await settleQueryNotifications()
    expect(picked).toMatchObject({ id: 'api', executionHostId: SERVER })
  })
})

describe('useNewWorkspaceRepositories hidden projects', () => {
  it('leaves hidden projects out of the picker and its default pick', async () => {
    const web: MobileWorkspaceRepo = {
      id: 'web',
      displayName: 'web',
      path: '/src/web',
      kind: 'git'
    }
    const client = desktopListing([{ ...repo(), hiddenAt: 1 }, web])
    let result: ReturnType<typeof useNewWorkspaceRepositories> | null = null
    mounted = hookMount(() => {
      result = useNewWorkspaceRepositories({ client, hostId: 'host-1', visible: true })
    })
    mounted.mount()
    await settleQueryNotifications()
    expect(result!.repos.map((entry) => entry.id)).toEqual(['web'])
    expect(result!.selectedRepo?.id).toBe('web')
  })
})
