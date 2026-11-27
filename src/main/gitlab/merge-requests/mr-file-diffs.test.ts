import { beforeEach, expect, it, vi } from 'vitest'
import { fetchMRFiles } from './mr-file-diffs'
import { glabExecFileAsync } from '../../git/command-runner/hosted-cli/glab-exec-file'

vi.mock('../../git/command-runner/hosted-cli/glab-exec-file', () => ({
  glabExecFileAsync: vi.fn()
}))

function glabFailure(stderr: string, stdout: string): Error {
  return Object.assign(new Error('Command failed: glab api'), { stderr, stdout })
}

const changedFile = {
  old_path: 'src/app.ts',
  new_path: 'src/app.ts',
  diff: '@@ -1 +1 @@\n-old\n+new\n'
}

beforeEach(() => {
  vi.mocked(glabExecFileAsync).mockReset()
})

it('reads the changes route on GitLab before 15.7 and remembers the host', async () => {
  vi.mocked(glabExecFileAsync).mockImplementation(async (args) => {
    if (args.some((arg) => arg.includes('/diffs'))) {
      throw glabFailure('glab: HTTP 404\n', '{"error":"404 Not Found"}')
    }
    return { stdout: JSON.stringify({ changes: [changedFile], overflow: false }), stderr: '' }
  })
  const projectRef = { host: 'gitlab.legacy.example', path: 'team/app' }

  const expected = [{ path: 'src/app.ts', status: 'modified', additions: 1, deletions: 1 }]
  await expect(fetchMRFiles('/repo', projectRef, 7)).resolves.toMatchObject(expected)
  await expect(fetchMRFiles('/repo', projectRef, 8)).resolves.toMatchObject(expected)

  const endpoints = vi.mocked(glabExecFileAsync).mock.calls.map(([args]) => args.at(-1))
  expect(endpoints).toEqual([
    'projects/team%2Fapp/merge_requests/7/diffs?per_page=100',
    'projects/team%2Fapp/merge_requests/7/changes',
    'projects/team%2Fapp/merge_requests/8/changes'
  ])
})
