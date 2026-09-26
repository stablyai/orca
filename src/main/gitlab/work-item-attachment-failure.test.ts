import { beforeEach, expect, it, vi } from 'vitest'
const { release } = vi.hoisted(() => ({ release: vi.fn() }))
vi.mock('./attachment-images', () => ({
  loadGitLabImages: vi.fn().mockRejectedValue(new Error('parser failure'))
}))
vi.mock('./gl-utils', () => ({
  acquire: vi.fn(),
  release,
  getGlabKnownHosts: vi.fn(),
  resolveIssueSource: vi.fn(),
  glabHostnameArgs: () => [],
  glabRepoExecOptions: () => ({}),
  glabExecFileAsync: async (args: string[]) => ({
    stdout: JSON.stringify(
      args.at(-1)?.includes('/discussions')
        ? []
        : {
            iid: 2594,
            title: 'Issue remains available',
            state: 'opened',
            description: 'Original description',
            web_url: 'https://gitlab.example/group/project/-/issues/2594'
          }
    )
  })
}))
import { loadGitLabImages } from './attachment-images'
import { getWorkItemDetails } from './work-item-details'
beforeEach(() => {
  release.mockClear()
  vi.mocked(loadGitLabImages).mockClear()
})
it.each(['issue', 'mr'] as const)(
  'preserves %s details and releases admission when preview parsing fails',
  async (type) => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const details = await getWorkItemDetails(
        '/repo',
        2594,
        type,
        undefined,
        null,
        {
          host: 'gitlab.example',
          path: 'group/project'
        },
        {},
        { includeImages: true }
      )
      expect(details?.body).toBe('Original description')
      expect(details?.item.number).toBe(2594)
      expect(details?.imageSources).toEqual({})
      expect(release).toHaveBeenCalledTimes(1)
      expect(warn).toHaveBeenCalled()
    } finally {
      warn.mockRestore()
    }
  }
)

it('does not download previews for polling or legacy callers', async () => {
  const details = await getWorkItemDetails('/repo', 1, 'issue', undefined, null, {
    host: 'gitlab.example',
    path: 'group/project'
  })
  expect(details?.body).toBe('Original description')
  expect(details?.imageSources).toBeUndefined()
  expect(loadGitLabImages).not.toHaveBeenCalled()
})
it('charges the description and metadata before budgeting remote previews', async () => {
  vi.mocked(loadGitLabImages).mockResolvedValueOnce({})
  const details = await getWorkItemDetails(
    '/repo',
    1,
    'issue',
    undefined,
    null,
    { host: 'gitlab.example', path: 'group/project' },
    {},
    { includeImages: true, maxReplyBytes: 4096 }
  )
  const expectedBudget = 4096 - Buffer.byteLength(JSON.stringify(details))
  expect(loadGitLabImages).toHaveBeenCalledWith(
    expect.any(Array),
    '/repo',
    expect.any(Object),
    null,
    {},
    expectedBudget
  )
})
