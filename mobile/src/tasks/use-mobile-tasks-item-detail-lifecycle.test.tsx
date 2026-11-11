import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ActionableTaskItem } from './mobile-tasks-project-workspace-types'
import {
  detailClient,
  GITLAB_DETAILS,
  gitlabItem,
  hydratedItem,
  mountDetail,
  success
} from './mobile-task-detail-hydration.test-fixture'

vi.mock('./mobile-tasks-dependencies', async () => {
  const react = await import('react')
  const { colors } = await import('../theme/mobile-theme')
  const { buildGitLabCheckSummary } = await import('./gitlab-check-summary')
  return { useEffect: react.useEffect, colors, buildGitLabCheckSummary }
})

vi.mock('./mobile-tasks-legacy-foundation', async () => import('./mobile-tasks-item-mapping'))

const mounts: Awaited<ReturnType<typeof mountDetail>>[] = []
async function mount(...args: Parameters<typeof mountDetail>) {
  const fixture = await mountDetail(...args)
  mounts.push(fixture)
  return fixture
}
afterEach(async () => {
  for (const fixture of mounts.splice(0)) {
    await fixture.dispose()
  }
})

describe('task detail request lifetime', () => {
  it('ignores results after another client becomes authoritative', async () => {
    const fixture = await mount(hydratedItem())
    const next = detailClient()
    await fixture.replaceClient(next.client)
    await fixture.transport.answer(success({ ...GITLAB_DETAILS, body: 'Old client' }))
    expect(fixture.state().payload).toBeNull()
    await next.answer(success({ ...GITLAB_DETAILS, body: 'Current client' }))
    expect(fixture.state()).toMatchObject({ loading: false, payload: { body: 'Current client' } })
    expect(next.requests).toHaveLength(1)
  })

  it.each([
    { id: 'mr:99', number: 99 },
    { repoId: 'other-repo' },
    { id: 'issue:12', type: 'issue' as const }
  ])('ignores an old item reply after selecting another target %j', async (source) => {
    const fixture = await mount(hydratedItem())
    const next = hydratedItem(source)
    const old = fixture.transport.pending()
    await fixture.select(next)
    const current = fixture.transport.requests[1]
    expect(current?.params).toMatchObject({
      repo: `id:${next.source.repoId}`,
      iid: next.source.number,
      type: next.source.type
    })
    await fixture.transport.answer(success({ ...GITLAB_DETAILS, body: 'Retired item' }), old)
    expect(fixture.state().payload).toBeNull()
    await fixture.transport.answer(success({ ...GITLAB_DETAILS, body: 'Current item' }))
    expect(fixture.state().payload).toMatchObject({ body: 'Current item' })
    expect(fixture.state().actionItem).toBe(next)
    expect(fixture.transport.requests).toHaveLength(2)
  })

  it.each([
    { host: 'other.gitlab.example', path: 'group/repo' },
    { host: 'gitlab.example', path: 'group/other-repo' }
  ])('reloads a changed GitLab project reference $host/$path', async (projectRef) => {
    const fixture = await mount()
    const old = fixture.transport.pending()
    await fixture.select(gitlabItem({ projectRef }))
    expect(fixture.transport.requests[1]?.params).toMatchObject({ projectRef })
    await fixture.transport.answer(success({ ...GITLAB_DETAILS, body: 'Old project' }), old)
    expect(fixture.state().payload).toBeNull()
    await fixture.transport.answer(success({ ...GITLAB_DETAILS, body: 'Current project' }))
    expect(fixture.transport.requests).toHaveLength(2)
    expect(fixture.state()).toMatchObject({ loading: false, payload: { body: 'Current project' } })
  })
})

describe('other detail providers', () => {
  it('ignores a GitLab reply after switching provider', async () => {
    const initial = gitlabItem()
    const fixture = await mount(initial)
    const old = fixture.transport.pending()
    const github: ActionableTaskItem = {
      ...initial,
      key: 'github:repo:pr:12',
      provider: 'github',
      source: {
        ...initial.source,
        type: 'pr',
        state: 'open',
        url: 'https://github.com/owner/repo/pull/12',
        prRepo: { owner: 'owner', repo: 'repo', host: 'github.com' }
      }
    }
    await fixture.select(github)
    await fixture.transport.answer(success({ ...GITLAB_DETAILS, body: 'Old GitLab' }), old)
    expect(fixture.state().payload).toBeNull()
    await fixture.transport.answer(success({ capabilities: [] }))
    await fixture.transport.answer(success({ body: 'GitHub body', item: github.source }))
    expect(fixture.transport.requests.map((request) => request.method)).toEqual([
      'gitlab.workItemDetails',
      'status.get',
      'github.workItemDetails'
    ])
    expect(fixture.state()).toMatchObject({
      loading: false,
      payload: { provider: 'github', body: 'GitHub body' }
    })
    expect(fixture.state().items[0]).toBe(initial)
  })
})
