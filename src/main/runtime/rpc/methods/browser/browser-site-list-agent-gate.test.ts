import '../../dispatch/testing/unused-default-rpc-methods.test-fixture'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { RpcDispatcher } from '../../dispatcher'
import type { RpcRequest } from '../../core'
import type { OrcaRuntimeService } from '../../../orca-runtime'
import { DESKTOP_RPC_CALLER, LOCAL_CLI_RPC_CALLER } from '../../callers/rpc-caller-identity'
import { setBrowserProfileSiteList } from '../../../../browser/sessions/site-list/browser-session-site-list'
import { BROWSER_CORE_METHODS } from './browser-core'
import { REPO_METHODS } from '../projects/repo'

const LOCKED = { ok: false, error: { code: 'browser_profile_site_list_locked' } }

function setup(repoProfileId: string | null = 'work') {
  const runtime = {
    getRuntimeId: () => 'test-runtime',
    showManagedWorktree: vi.fn(async () => ({ id: 'r1::/w', repoId: 'r1' })),
    showRepo: vi.fn(async () => ({ id: 'r1', browserProfileId: repoProfileId })),
    requireStore: () => ({ getSettings: () => ({}) }),
    browserTabCurrent: vi.fn(async () => ({ tab: { profileId: 'work' } })),
    browserOpenUrlOnClient: vi.fn(async () => ({ browserPageId: 'p2' })),
    browserTabCreate: vi.fn(async (_params: unknown) => ({ browserPageId: 'p1' })),
    browserTabSetProfile: vi.fn(async () => ({})),
    browserTabProfileClone: vi.fn(async () => ({})),
    browserProfileDelete: vi.fn(async () => ({})),
    updateRepo: vi.fn(async () => ({ id: 'r1' }))
  }
  const dispatcher = new RpcDispatcher({
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the gated methods read only these runtime members.
    runtime: runtime as unknown as OrcaRuntimeService,
    methods: [...BROWSER_CORE_METHODS, ...REPO_METHODS]
  })
  const call = (method: string, params: unknown, caller = LOCAL_CLI_RPC_CALLER) =>
    dispatcher.dispatch({ id: 'r', authToken: 't', method, params } as RpcRequest, { caller })
  return { runtime, call }
}

afterEach(() => {
  setBrowserProfileSiteList('work', [])
  setBrowserProfileSiteList('default', [])
})

describe('agents and a browser profile with a site list', () => {
  it('keeps an agent tab in the repo profile, refusing another one', async () => {
    setBrowserProfileSiteList('work', ['example.com'])
    const { runtime, call } = setup()
    expect(await call('browser.tabCreate', { worktree: 'id:w', profileId: 'other' })).toMatchObject(
      LOCKED
    )
    expect(runtime.browserTabCreate).not.toHaveBeenCalled()
    await call('browser.tabCreate', { worktree: 'id:w' })
    expect(runtime.browserTabCreate.mock.calls[0][0]).toMatchObject({ profileId: 'work' })
  })

  it('keeps an agent tab in a listed Default profile when the repo picks none', async () => {
    setBrowserProfileSiteList('default', ['example.com'])
    const { runtime, call } = setup(null)
    expect(await call('browser.tabCreate', { worktree: 'id:w', profileId: 'other' })).toMatchObject(
      LOCKED
    )
    expect(runtime.browserTabCreate).not.toHaveBeenCalled()
    await call('browser.tabCreate', { worktree: 'id:w' })
    expect(runtime.browserTabCreate.mock.calls[0][0]).toMatchObject({ profileId: 'default' })
  })

  it('leaves the owner and unlisted profiles alone on tab create', async () => {
    const { runtime, call } = setup()
    const params = { worktree: 'id:w', profileId: 'other' }
    setBrowserProfileSiteList('work', ['example.com'])
    await call('browser.tabCreate', params, DESKTOP_RPC_CALLER)
    setBrowserProfileSiteList('work', [])
    await call('browser.tabCreate', params)
    expect(runtime.browserTabCreate.mock.calls.map(([sent]) => sent)).toEqual([params, params])
  })

  it('refuses an agent opening a URL in Default when its worktree belongs in a listed profile', async () => {
    const { runtime, call } = setup()
    const open = { worktree: 'id:w', url: 'https://example.com' }
    setBrowserProfileSiteList('work', ['example.com'])
    expect(await call('browser.openUrl', open)).toMatchObject(LOCKED)
    expect(await call('browser.openUrl', open, DESKTOP_RPC_CALLER)).toMatchObject({ ok: true })
    setBrowserProfileSiteList('work', [])
    expect(await call('browser.openUrl', open)).toMatchObject({ ok: true })
    expect(runtime.browserOpenUrlOnClient).toHaveBeenCalledTimes(2)
  })

  it.each([
    ['browser.tabSetProfile', 'browserTabSetProfile'],
    ['browser.tabProfileClone', 'browserTabProfileClone']
  ] as const)('%s: refuses an agent moving a listed tab out', async (method, runtimeMethod) => {
    const { runtime, call } = setup()
    setBrowserProfileSiteList('work', ['example.com'])
    expect(await call(method, { profileId: 'other' })).toMatchObject(LOCKED)
    expect(await call(method, { profileId: 'work' })).toMatchObject({ ok: true })
    expect(await call(method, { profileId: 'other' }, DESKTOP_RPC_CALLER)).toMatchObject({
      ok: true
    })
    setBrowserProfileSiteList('work', [])
    expect(await call(method, { profileId: 'other' })).toMatchObject({ ok: true })
    expect(runtime[runtimeMethod]).toHaveBeenCalledTimes(3)
  })

  it('refuses an agent deleting a listed profile', async () => {
    const { runtime, call } = setup()
    setBrowserProfileSiteList('work', ['example.com'])
    expect(await call('browser.profileDelete', { profileId: 'work' })).toMatchObject(LOCKED)
    expect(
      await call('browser.profileDelete', { profileId: 'work' }, DESKTOP_RPC_CALLER)
    ).toMatchObject({ ok: true })
    expect(await call('browser.profileDelete', { profileId: 'plain' })).toMatchObject({ ok: true })
    expect(runtime.browserProfileDelete).toHaveBeenCalledTimes(2)
  })

  it("refuses an agent changing a repo's listed browser profile", async () => {
    const { runtime, call } = setup()
    const update = { repo: 'id:r1', updates: { browserProfileId: 'other' } }
    setBrowserProfileSiteList('work', ['example.com'])
    expect(await call('repo.update', update)).toMatchObject(LOCKED)
    expect(await call('repo.update', update, DESKTOP_RPC_CALLER)).toMatchObject({ ok: true })
    setBrowserProfileSiteList('work', [])
    expect(await call('repo.update', update)).toMatchObject({ ok: true })
    expect(runtime.updateRepo).toHaveBeenCalledTimes(2)
  })
})
