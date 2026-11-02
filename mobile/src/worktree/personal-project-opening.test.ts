import { beforeEach, describe, expect, it, vi } from 'vitest'
import { getDefaultUIState } from '../../../src/shared/constants'
import { projectHostSetupProjectionFromRepos } from '../../../src/shared/project-host-setup-projection'
import { buildMobileProjectSectionCatalog } from '../../../src/shared/mobile-project-sections-contract'
import { ProjectSectionCatalogSchema } from '../../../src/shared/project-section-catalog-schema'
import { RecordProjectOpenParams } from '../../../src/shared/rpc-contract/personal-project-order-params'
import { mutatePersonalProjectOrder } from '../../../src/shared/personal-project-order-writes'
import type { Repo } from '../../../src/shared/repo-types'
import { stubRpcClient } from '../transport/rpc-client-test-stub'
import type { Worktree } from './workspace-list-types'
import { captureMobilePersonalOpening } from './personal-project-opening'

const storage = vi.hoisted(() => ({ read: vi.fn() }))
vi.mock('../storage/mirrored-storage-keys', () => ({ readMirroredKeyOrStore: storage.read }))

const repos: Repo[] = ['a', 'b', 'c'].map((id) => ({
  id,
  path: `/${id}`,
  displayName: id,
  badgeColor: '',
  addedAt: 0,
  executionHostId: 'local'
}))
const rows: Worktree[] = repos.map((repo) => ({
  worktreeId: `${repo.id}::${repo.path}`,
  repoId: repo.id,
  repo: repo.displayName,
  displayName: repo.displayName,
  branch: 'main',
  path: repo.path,
  liveTerminalCount: 0,
  hasAttachedPty: false,
  unread: false,
  isPinned: false,
  linkedPR: null
}))
const key = (id: string) => JSON.stringify(['local', 'local', `repo:${id}`])
function fixture(catalogRepos = repos) {
  let ui = getDefaultUIState()
  const runtime = {
    getUIState: () => ui,
    updateUIState: (patch: Partial<typeof ui>) => (ui = { ...ui, ...patch })
  }
  const sendRequest = vi.fn(async (method: string, params?: unknown) => {
    if (method !== 'ui.recordProjectOpen') {
      throw new Error(`unexpected ${method}`)
    }
    return {
      id: 'open',
      ok: true as const,
      result: mutatePersonalProjectOrder(runtime, RecordProjectOpenParams.parse(params))
    }
  })
  const client = stubRpcClient({ sendRequest })
  const catalog = ProjectSectionCatalogSchema.parse(
    buildMobileProjectSectionCatalog(
      catalogRepos,
      projectHostSetupProjectionFromRepos(catalogRepos),
      'manual'
    )
  )
  return {
    capture: (target: Worktree) =>
      captureMobilePersonalOpening({
        hostId: 'view-owner',
        client,
        capabilities: ['ui.personalProjectOrder.v1'],
        catalog,
        target,
        rows
      }),
    sendRequest,
    order: () => ui.personalProjectOrder
  }
}
beforeEach(() => {
  storage.read.mockReset()
  storage.read.mockResolvedValue(JSON.stringify({ hostId: 'view-owner', worktreeId: 'c::/c' }))
})

describe('acknowledged mobile personal openings', () => {
  it('counts concurrent acknowledgements of the same project once', async () => {
    const f = fixture()
    const [first, second] = await Promise.all([f.capture(rows[0]), f.capture(rows[0])])
    await Promise.all([first?.(), second?.()])
    expect(f.order()?.projects[key('a')].openCount).toBe(1)
    expect(f.sendRequest).toHaveBeenCalledTimes(1)
  })
  it('uses acknowledgement order rather than capture order for previous project', async () => {
    const f = fixture()
    const [a, b] = await Promise.all([f.capture(rows[0]), f.capture(rows[1])])
    await b?.()
    await a?.()
    expect(f.sendRequest.mock.calls[1]?.[1]).toMatchObject({
      projectKey: key('a'),
      previousProjectKey: key('b')
    })
  })
  it('counts a return to the captured previous project after another acknowledgement', async () => {
    const f = fixture()
    const [b, c] = await Promise.all([f.capture(rows[1]), f.capture(rows[2])])
    await b?.()
    await c?.()
    expect(f.order()?.projects[key('c')].openCount).toBe(1)
  })
  it('deduplicates a repeated acknowledgement without rolling back the current project', async () => {
    const f = fixture()
    const a = await f.capture(rows[0])
    await a?.()
    const b = await f.capture(rows[1])
    await b?.()
    await a?.()
    const againB = await f.capture(rows[1])
    await againB?.()
    expect(f.sendRequest).toHaveBeenCalledTimes(2)
    expect(f.order()?.projects[key('b')].openCount).toBe(1)
  })
  it('resolves a hostless row to local when another owner has the same repo id', async () => {
    const f = fixture([...repos, { ...repos[0], executionHostId: 'runtime:remote' }])
    const opening = await f.capture(rows[0])
    expect(opening).not.toBeNull()
    await opening?.()
    expect(f.sendRequest.mock.calls[0]?.[1]).toMatchObject({ projectKey: key('a') })
  })
  it('uses the view owner client while keeping a remote execution owner in the project key', async () => {
    const f = fixture([...repos, { ...repos[0], executionHostId: 'runtime:remote' }])
    const opening = await f.capture({ ...rows[0], hostId: 'runtime:remote' })
    await opening?.()
    expect(f.sendRequest.mock.calls[0]?.[1]).toMatchObject({
      projectKey: JSON.stringify(['runtime:remote', 'runtime:remote', 'repo:a'])
    })
  })
  it('resolves a hostless previous project to local despite a same-id remote registration', async () => {
    const f = fixture([...repos, { ...repos[2], executionHostId: 'runtime:remote' }])
    await (
      await f.capture(rows[2])
    )?.()
    expect(f.sendRequest).not.toHaveBeenCalled()
  })
  it('does not count captures without acknowledgements or repeated same-project acknowledgements', async () => {
    const f = fixture()
    await f.capture(rows[0])
    expect(f.sendRequest).not.toHaveBeenCalled()
    const c = await f.capture(rows[2])
    await c?.()
    expect(f.sendRequest).not.toHaveBeenCalled()
  })
})
