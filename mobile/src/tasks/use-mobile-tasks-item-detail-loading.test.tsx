import { afterEach, expect, it, vi } from 'vitest'

import { mountDetail, success } from './mobile-task-detail-hydration.test-fixture'

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

function githubItem(owner = 'fork') {
  return {
    key: `github:${owner}`,
    provider: 'github' as const,
    title: 'PR',
    subtitle: 'clone',
    status: 'Open',
    updatedAt: '',
    source: {
      id: 'pr:93',
      type: 'pr' as const,
      number: 93,
      title: 'PR',
      state: 'open' as const,
      url: `https://github.corp/${owner}/widgets/pull/93`,
      labels: [],
      updatedAt: '',
      author: null,
      repoId: 'clone',
      repoName: 'clone'
    }
  }
}
const githubDetails = (owner = 'fork') => ({
  item: githubItem(owner).source,
  body: `${owner} body`,
  comments: [],
  files: [{ path: `${owner}.ts` }],
  headSha: `${owner}-head`,
  baseSha: `${owner}-base`,
  pullRequestId: `PR_${owner}`
})
const targetStatus = success({
  runtimeId: 'a',
  hostDescriptor: { installationId: 'host-a' },
  capabilities: ['github.exact-work-item-target.v1']
})
it('native Tasks validates decoded full identity before publishing IDs, files and SHAs, then retries successfully', async () => {
  const fixture = await mount(githubItem())
  await fixture.transport.answer(targetStatus)
  expect(fixture.transport.requests.at(-1)?.params).toMatchObject({
    ownerRepo: { owner: 'fork', repo: 'widgets', host: 'github.corp' }
  })
  await fixture.transport.answer(success(githubDetails('upstream')))
  expect(fixture.state()).toMatchObject({
    payload: null,
    loading: false,
    error: expect.stringContaining('fork/widgets#93')
  })
  await fixture.refresh()
  await fixture.transport.answer(targetStatus)
  await fixture.transport.answer(success(githubDetails()))
  expect(fixture.state()).toMatchObject({
    loading: false,
    payload: {
      body: 'fork body',
      headSha: 'fork-head',
      pullRequestId: 'PR_fork',
      files: [{ path: 'fork.ts' }]
    }
  })
  await fixture.refresh()
  await fixture.transport.answer(targetStatus)
  const pending = fixture.transport.pending()
  await fixture.select(githubItem('upstream'))
  await fixture.transport.answer(targetStatus)
  await fixture.transport.answer(success(githubDetails('fork')), pending)
  expect(fixture.state().payload).toBeNull()
  await fixture.transport.answer(success(githubDetails('upstream')))
  expect(fixture.state().payload).toMatchObject({ body: 'upstream body' })
})
