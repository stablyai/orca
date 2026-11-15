import { expect, it, vi } from 'vitest'
import { createBackendDesktopCapabilities } from './backend-desktop-capabilities'

vi.mock('../telemetry/client', () => ({ isTelemetryEnabled: vi.fn(), track: vi.fn() }))
vi.mock('../claude-usage/transcript-file-discovery', () => ({
  claudeProfileTranscriptDirs: vi.fn()
}))

it('loads remembered worktrees before sending the backend attribution catalog', async () => {
  const remembered = new Map<string, string>()
  let finishLoading!: () => void
  const loaded = new Promise<void>((resolve) => {
    finishLoading = resolve
  }).then(() => {
    remembered.set('repo-1::/ws/removed', 'removed')
  })
  const capability = createBackendDesktopCapabilities({
    getRepos: () => [
      { id: 'repo-1', path: '/src/app', displayName: 'app', badgeColor: '#000000', addedAt: 0 }
    ],
    getAllWorktreeMeta: () => ({}),
    getRememberedWorktreeDisplayNames: () => remembered,
    whenLoaded: () => loaded
  })

  const catalog = capability('usage.catalog', null)
  finishLoading()

  expect(await catalog).toEqual({
    repoIds: ['repo-1'],
    worktreesByRepo: [
      [
        'repo-1',
        [
          { worktreeId: 'repo-1::/src/app', path: '/src/app', displayName: 'app' },
          { worktreeId: 'repo-1::/ws/removed', path: '/ws/removed', displayName: 'removed' }
        ]
      ]
    ]
  })
})
