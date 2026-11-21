import { describe, expect, it } from 'vitest'
import { listTaskSourceRepos } from './hosted-repo-selection'

const upstream = { owner: 'acme', repo: 'web' }
const desktopRepo = { id: 'desktop-web', executionHostId: 'local' as const, upstream, addedAt: 2 }
const serverTwin = {
  id: 'server-web',
  executionHostId: 'runtime:build-box' as const,
  upstream,
  addedAt: 1
}
const folder = { id: 'notes', kind: 'folder' as const }
const repos = [serverTwin, desktopRepo, folder]

describe('task source repos', () => {
  it('reads one repo per project, keeping the twin the user picked', () => {
    expect(listTaskSourceRepos(repos, new Set()).map((repo) => repo.id)).toEqual(['desktop-web'])
    expect(listTaskSourceRepos(repos, new Set(['server-web'])).map((repo) => repo.id)).toEqual([
      'server-web'
    ])
    expect(
      listTaskSourceRepos(repos, new Set(['server-web', 'desktop-web'])).map((repo) => repo.id)
    ).toEqual(['desktop-web'])
  })
})
