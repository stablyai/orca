import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ProviderCheckSummary } from '../../../src/shared/github/pull-request-types'
import type { GitLabWorkItem } from './mobile-tasks-provider-detail-types'
import {
  GITLAB_DETAILS,
  gitlabItem,
  hydratedItem,
  mountDetail,
  SUCCESS_CHECKS,
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

const summaryChanges: { field: keyof ProviderCheckSummary; summary: ProviderCheckSummary }[] = [
  { field: 'state', summary: { ...SUCCESS_CHECKS, state: 'failure' } },
  { field: 'total', summary: { ...SUCCESS_CHECKS, total: 9 } },
  { field: 'passed', summary: { ...SUCCESS_CHECKS, passed: 9 } },
  { field: 'failed', summary: { ...SUCCESS_CHECKS, failed: 9 } },
  { field: 'pending', summary: { ...SUCCESS_CHECKS, pending: 9 } },
  { field: 'neutral', summary: { ...SUCCESS_CHECKS, neutral: 9 } }
]
const statusChanges: { field: string; source: Partial<GitLabWorkItem> }[] = [
  { field: 'mergeable', source: { mergeable: 'CONFLICTING' } },
  { field: 'reviewDecision', source: { reviewDecision: 'review_required' } },
  { field: 'reviewerCount', source: { reviewerCount: 9 } }
]

describe('GitLab task detail hydration', () => {
  it('settles repeated identical replies and keeps the loaded sheet readable', async () => {
    const fixture = await mount()
    for (let round = 0; round < 6; round += 1) {
      await fixture.transport.answer()
    }
    expect(fixture.transport.requests).toHaveLength(2)
    expect(fixture.transport.pending()).toHaveLength(0)
    expect(fixture.state()).toMatchObject({
      loading: false,
      error: '',
      payload: { provider: 'gitlab', body: GITLAB_DETAILS.body }
    })
  })

  it('retains already hydrated selected and list references after an unrelated render', async () => {
    const initial = hydratedItem()
    const other = gitlabItem({ id: 'mr:99', number: 99 })
    const items = [initial, other]
    const fixture = await mount(initial, items)
    await fixture.rerender()
    expect(fixture.transport.requests).toHaveLength(1)
    await fixture.transport.answer()
    expect(fixture.transport.requests).toHaveLength(1)
    expect(fixture.state().actionItem).toBe(initial)
    expect(fixture.state().items).toBe(items)
    expect(fixture.state().items[1]).toBe(other)
    expect(fixture.transport.requests[0]).toMatchObject({
      method: 'gitlab.workItemDetails',
      params: { repo: 'id:repo', iid: 12, type: 'mr', projectRef: initial.source.projectRef },
      options: { timeoutMs: 30_000 }
    })
  })

  it.each(summaryChanges)(
    'hydrates a changed checks $field before settling',
    async ({ summary }) => {
      const initial = hydratedItem({ checksSummary: summary })
      const other = gitlabItem({ id: 'mr:99' })
      const fixture = await mount(initial, [initial, other])
      await fixture.transport.answer()
      expect(fixture.state().actionItem?.source).toMatchObject({ checksSummary: SUCCESS_CHECKS })
      expect(fixture.state().items[0]?.source).toMatchObject({ checksSummary: SUCCESS_CHECKS })
      expect(fixture.state().items[1]).toBe(other)
      const selected = fixture.state().actionItem
      const items = fixture.state().items
      await fixture.transport.answer()
      expect(fixture.transport.requests).toHaveLength(2)
      expect(fixture.transport.pending()).toHaveLength(0)
      expect(fixture.state().actionItem).toBe(selected)
      expect(fixture.state().items).toBe(items)
    }
  )

  it.each(statusChanges)('hydrates provided $field before settling', async ({ source }) => {
    const fixture = await mount(hydratedItem(source))
    await fixture.transport.answer()
    expect(fixture.state().actionItem?.source).toMatchObject({
      mergeable: 'MERGEABLE',
      reviewDecision: 'approved',
      reviewerCount: 1
    })
    await fixture.transport.answer()
    expect(fixture.transport.requests).toHaveLength(2)
    expect(fixture.transport.pending()).toHaveLength(0)
  })

  it('preserves absent optional status fields while accepting empty checks', async () => {
    const initial = hydratedItem({
      mergeable: 'CONFLICTING',
      reviewDecision: 'review_required',
      reviewerCount: 9
    })
    const fixture = await mount(initial)
    const reply = success({ body: 'No status fields', comments: [], pipelineJobs: [] })
    await fixture.transport.answer(reply)
    expect(fixture.state().actionItem?.source).toMatchObject({
      checksSummary: { state: 'none', total: 0, passed: 0, failed: 0, pending: 0, neutral: 0 },
      mergeable: 'CONFLICTING',
      reviewDecision: 'review_required',
      reviewerCount: 9
    })
    await fixture.transport.answer(reply)
    expect(fixture.transport.requests).toHaveLength(2)
    expect(fixture.state()).toMatchObject({ loading: false, payload: { body: 'No status fields' } })
  })

  it('still reads explicit refreshes and changed details', async () => {
    const fixture = await mount(hydratedItem())
    await fixture.transport.answer()
    await fixture.refresh()
    await fixture.transport.answer(success({ ...GITLAB_DETAILS, body: 'Updated body' }))
    expect(fixture.transport.requests).toHaveLength(2)
    expect(fixture.state()).toMatchObject({ loading: false, payload: { body: 'Updated body' } })
  })
})
