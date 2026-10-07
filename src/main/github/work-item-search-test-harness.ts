/* oxlint-disable anti-slop/no-module-mocking -- Vitest support module for the 6 work-item-search specs, not shipped code, and it falls outside
   the *.test / *.spec / tests glob set. One consumer lives in tests/e2e, where the relative mock ids ('../git/...') resolve to
   different modules, so moving these calls into the specs would silently stop mocking there. */
import { afterEach, beforeEach, vi } from 'vitest'
import type { Mock } from 'vitest'
import { randomUUID } from 'node:crypto'
import { basename } from 'node:path'
import type * as GithubApiRepositoryModule from './github-api-repository'
import { WorkItemSearchApi } from './__fixtures__/work-item-search-api'

const {
  capture,
  sourceContext
}: {
  capture: Mock<WorkItemSearchApi['capture']>
  sourceContext: { host: string; available: boolean }
} = vi.hoisted(() => ({
  capture: vi.fn<WorkItemSearchApi['capture']>(),
  sourceContext: { host: 'github.com', available: true }
}))
vi.mock('../git/command-runner/exec-file-capture', () => ({
  execFileCaptureToTermination: capture
}))
vi.mock('../git/command-runner/wsl-command-resolution', () => ({
  resolveCommand: (binary: string, args: string[], cwd?: string, distro?: string) => ({
    binary,
    args,
    cwd,
    wsl: distro ? { distro } : null,
    wslMode: null
  }),
  resolveDefaultWslCli: () => null
}))
vi.mock('../git/runner', async () => ({
  ghExecFileAsync: (await import('../git/command-runner/gh-exec-file')).ghExecFileAsync,
  gitExecFileAsync: vi.fn()
}))
vi.mock('./github-api-repository', async (importOriginal) => {
  const actual = await importOriginal<typeof GithubApiRepositoryModule>()
  const source = (repoPath: string) =>
    sourceContext.available
      ? { owner: 'fixture', repo: basename(repoPath), host: sourceContext.host }
      : null
  return {
    ...actual,
    resolveIssueGitHubApiRepositorySource: async (repoPath: string) => ({
      source: source(repoPath),
      fellBack: false
    }),
    getOriginGitHubApiRepository: async (repoPath: string) => source(repoPath),
    getGitHubApiRepositoryForRemote: async () => null
  }
})

import { _resetRateLimitCache } from './rate-limit'
import { clearGhRateLimitBlock, ghRateLimitScopeKey } from '../git/gh-rate-limit-breaker'
export let api: WorkItemSearchApi
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(0)
  vi.stubEnv('GH_HOST', 'github.com')
  vi.stubEnv('ORCA_WORK_ITEM_SEARCH_FIXTURE', randomUUID())
  _resetRateLimitCache()
  for (const runtime of ['native', 'wsl:ubuntu', 'wsl:debian']) {
    for (const host of ['github.com', 'github.example.com']) {
      for (const bucket of ['core', 'graphql', 'search'] as const) {
        clearGhRateLimitBlock(bucket, ghRateLimitScopeKey(runtime, host))
      }
    }
  }
  sourceContext.host = 'github.com'
  sourceContext.available = true
  api = new WorkItemSearchApi()
  capture.mockReset().mockImplementation(api.capture.bind(api))
})
afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllEnvs()
})

export { capture, sourceContext }
