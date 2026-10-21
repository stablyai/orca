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

  it('ignores an old item reply after selecting another item', async () => {
    const fixture = await mount(hydratedItem())
    const next = hydratedItem({ id: 'mr:99', number: 99 })
    const old = fixture.transport.pending()
    await fixture.select(next)
    const current = fixture.transport.requests[1]
    expect(current?.params).toMatchObject({ iid: 99 })
    await fixture.transport.answer(success({ ...GITLAB_DETAILS, body: 'Retired item' }), old)
    expect(fixture.state().payload).toBeNull()
    await fixture.transport.answer(success({ ...GITLAB_DETAILS, body: 'Current item' }))
    expect(fixture.state().payload).toMatchObject({ body: 'Current item' })
    expect(fixture.state().actionItem).toBe(next)
    expect(fixture.transport.requests).toHaveLength(2)
  })

  it('stops requests and ignores an outstanding reply on close', async () => {
    const fixture = await mount()
    await fixture.select(null)
    await fixture.transport.answer()
    expect(fixture.state()).toMatchObject({ actionItem: null, payload: null, loading: false })
    expect(fixture.transport.requests).toHaveLength(1)
  })

  it('ignores a reply after unmount', async () => {
    const fixture = await mount()
    const state = fixture.state()
    await fixture.dispose()
    await fixture.transport.answer()
    expect(fixture.state()).toBe(state)
    expect(fixture.transport.requests).toHaveLength(1)
  })

  it.each([
    success(null),
    success('invalid'),
    { id: 'detail', ok: false as const, error: { code: 'refused', message: 'Access refused' } }
  ])('does not retry refused or unreadable details', async (reply) => {
    const fixture = await mount()
    await fixture.transport.answer(reply)
    expect(fixture.transport.requests).toHaveLength(1)
    expect(fixture.transport.pending()).toHaveLength(0)
    expect(fixture.state().loading).toBe(false)
    expect(fixture.state().error).not.toBe('')
  })

  it('does not retry a transport failure', async () => {
    const fixture = await mount()
    await fixture.transport.reject(new Error('Transport lost'))
    expect(fixture.state()).toMatchObject({ loading: false, error: 'Transport lost' })
    expect(fixture.transport.requests).toHaveLength(1)
  })
})

describe('other detail providers', () => {
  it('keeps GitHub and Linear reads stable after successful replies', async () => {
    const gitlab = gitlabItem()
    const github: ActionableTaskItem = {
      ...gitlab,
      provider: 'github',
      source: { ...gitlab.source, type: 'pr', state: 'open' }
    }
    const fixture = await mount(github)
    await fixture.transport.answer(success({ body: 'GitHub body' }))
    expect(fixture.transport.requests).toHaveLength(1)
    expect(fixture.state()).toMatchObject({ loading: false, payload: { provider: 'github' } })
    const issue = {
      id: 'linear-1',
      identifier: 'ENG-1',
      title: 'Issue',
      url: 'https://linear.example/ENG-1',
      updatedAt: '',
      priority: 0,
      labels: [],
      state: { name: 'Todo', type: 'unstarted', color: '' },
      team: { id: 'team', name: 'Team', key: 'ENG' }
    }
    const linear: ActionableTaskItem = { ...gitlab, provider: 'linear', source: issue }
    await fixture.select(linear)
    expect(fixture.transport.requests.slice(1).map((request) => request.method)).toEqual([
      'linear.getIssue',
      'linear.issueComments'
    ])
    await fixture.transport.answer((request) =>
      success(request.method === 'linear.issueComments' ? [] : issue)
    )
    expect(fixture.transport.requests).toHaveLength(3)
    expect(fixture.state()).toMatchObject({ loading: false, payload: { provider: 'linear' } })
    expect(fixture.state().actionItem).toBe(linear)
  })
})
