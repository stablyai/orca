import { expect, it, vi } from 'vitest'
import { getPRFiles } from './pull-request-file-data'
import { ghExecFileAsync } from '../../../git/command-runner/hosted-cli/gh-exec-file'

vi.mock('../../../git/command-runner/hosted-cli/gh-exec-file', () => ({
  ghExecFileAsync: vi.fn()
}))

it('returns the current changed files on an explicit refresh', async () => {
  vi.mocked(ghExecFileAsync).mockImplementation(async (args) => ({
    stdout: JSON.stringify([
      {
        filename: args.includes('--cache') ? 'old.ts' : 'current.ts',
        status: 'added',
        additions: 1,
        deletions: 0,
        changes: 1
      }
    ]),
    stderr: ''
  }))
  const repository = { owner: 'acme', repo: 'project', host: 'github.com' }

  await expect(getPRFiles('/repo', 7, repository)).resolves.toMatchObject([{ path: 'old.ts' }])
  await expect(
    getPRFiles('/repo', 7, repository, null, {}, { noCache: true })
  ).resolves.toMatchObject([{ path: 'current.ts' }])
})
