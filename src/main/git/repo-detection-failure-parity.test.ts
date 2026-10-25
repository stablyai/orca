import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import * as runner from './runner'
import { inspectGitRepoForRegistration, inspectGitRepoForRegistrationAsync } from './repo-detection'

let fixture: string
beforeEach(() => {
  fixture = mkdtempSync(join(tmpdir(), 'orca-repo-failure-parity-'))
  mkdirSync(join(fixture, '.git', 'objects'), { recursive: true })
  mkdirSync(join(fixture, '.git', 'refs'), { recursive: true })
  writeFileSync(join(fixture, '.git', 'HEAD'), 'ref: refs/heads/main\n')
  writeFileSync(join(fixture, '.git', 'config'), '[core]\n bare = false\n')
})
afterEach(() => {
  vi.restoreAllMocks()
  rmSync(fixture, { recursive: true, force: true })
})

it.each([0, 1, 2, 3, 4])(
  'preserves registration fallback and command order when command %i fails',
  async (failAt) => {
    // Ambiguous combined output requires separate root, Git directory and common directory reads.
    const outputs = [
      'true\nfalse\n',
      `true\n${fixture}\nextra\n.git\n.git\n`,
      `${fixture}\n`,
      '.git\n',
      '.git\n'
    ]
    const sync = vi.spyOn(runner, 'gitExecFileSync')
    const async = vi.spyOn(runner, 'gitExecFileAsync')
    let syncIndex = 0
    let asyncIndex = 0
    sync.mockImplementation(() => {
      const index = syncIndex++
      if (index === failAt) {
        throw new Error('rejected stage')
      }
      return outputs[index] ?? ''
    })
    async.mockImplementation(async () => {
      const index = asyncIndex++
      if (index === failAt) {
        throw new Error('rejected stage')
      }
      return { stdout: outputs[index] ?? '', stderr: '' }
    })
    const expected = inspectGitRepoForRegistration(fixture)
    expect(expected).toEqual({ isRepo: true, rootPath: fixture, mainRepoPath: null })
    expect(await inspectGitRepoForRegistrationAsync(fixture)).toEqual(expected)
    expect(async.mock.calls.map(([args]) => args)).toEqual(sync.mock.calls.map(([args]) => args))
  }
)
