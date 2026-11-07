import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type * as Ansi from '../../shared/ansi-escape-sequences'
const { git, execute, scan, signature } = vi.hoisted(() => ({
  git: vi.fn(),
  execute: vi.fn(),
  scan: vi.fn(),
  signature: vi.fn()
}))
vi.mock('../git/command-runner/git-exec-file', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  gitExecFileAsync: git
}))

vi.mock('../git/command-runner/glab-exec-file', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  glabExecFileAsync: execute
}))
vi.mock('../github/local-git-config-signature', () => ({ readLocalGitConfigSignature: signature }))
vi.mock('../../shared/ansi-escape-sequences', async (original) => {
  const actual = await original<typeof Ansi>()
  return {
    ...actual,
    stripAnsiEscapeSequences: vi.fn(actual.stripAnsiEscapeSequences).mockImplementation((s) => {
      scan(s.length)
      return actual.stripAnsiEscapeSequences(s)
    })
  }
})
import { listIssues } from './issues'
import { _resetProjectRefCache } from './gitlab-project-ref-resolution'
import {
  _resetKnownHostsCache,
  getGlabKnownHosts,
  getGlabPartialHosts
} from './gitlab-known-host-probe'
import { PROBE_COALESCE_STALE_MS } from '../git/remotes/coalesced-probe'
const completed = { code: 1, killed: false, signal: null, outputTruncated: false }
const failure = (stderr = '', metadata = {}) =>
  Object.assign(new Error('auth failed'), completed, { stdout: '', stderr }, metadata)
const login = (host: string) => `  ✓ Logged in to ${host} as user (config file)\n`
const fetchIssues = () => listIssues('/repo-pr34184', 20, 'origin')
const counts = () => [
  execute.mock.calls.filter(([a]) => a.length === 2).length,
  execute.mock.calls.filter(([a]) => a[2] === '--hostname').length
]
const urlReads = () => git.mock.calls.filter(([args]) => args[1] === 'get-url').length
let remoteUrl: string
let globalError: Error | undefined
let hostError: Error | undefined
beforeEach(() => {
  _resetKnownHostsCache()
  _resetProjectRefCache()
  signature.mockReset().mockResolvedValue('sig-1')
  remoteUrl = 'https://alpha.test:8443/group/project.git'
  git.mockReset().mockImplementation(async (args: string[]) => {
    if (args[0] === 'remote' && args[1] === 'get-url') {
      return { stdout: remoteUrl }
    }
    if (args[0] === 'remote' && args[1] === '-v') {
      return { stdout: `origin\t${remoteUrl} (fetch)\n` }
    }
    throw new Error(`Unexpected git command: ${args.join(' ')}`)
  })
  scan.mockClear()
  vi.spyOn(Date, 'now').mockReturnValue(1_000)
  globalError = failure(login('alpha.test:8443'))
  hostError = failure('', { code: 'ENOENT' })
  execute.mockReset().mockImplementation(async (args: string[]) => {
    if (args[0] === 'api') {
      return { stdout: '[{"iid":7,"title":"Recovered","state":"opened","labels":[]}]' }
    }
    const error = args.length === 2 ? globalError : hostError
    if (error) {
      throw error
    }
    return { stdout: login(args[3] ?? 'beta.test'), stderr: '' }
  })
})
afterEach(() => vi.restoreAllMocks())

it('applies late partial facts only to the current unsigned remote', async () => {
  signature.mockResolvedValue(undefined)
  remoteUrl = 'https://beta.test/group/project.git'
  expect((await fetchIssues()).error?.type).toBe('not_found')
  vi.mocked(Date.now).mockReturnValue(16_000)
  globalError = failure(login('beta.test'))
  remoteUrl = 'https://changed.test/group/project.git'
  expect((await fetchIssues()).error?.type).toBe('not_found')
  remoteUrl = 'https://beta.test/group/project.git'
  expect((await fetchIssues()).items[0]?.number).toBe(7)
  expect(urlReads()).toBe(3)
  expect(counts()).toEqual([2, 2])
})

it.each([
  { killed: true },
  { signal: 'SIGTERM' },
  { name: 'AbortError' },
  { outputTruncated: true },
  { outputTruncated: true, code: 0 },
  { code: null },
  { code: 'ENOENT' },
  { code: undefined }
])('rejects incomplete facts and retries: %j', async (metadata) => {
  globalError = failure(login('incomplete.test'), metadata)
  await getGlabKnownHosts()
  expect(getGlabPartialHosts()).toEqual([])
  vi.mocked(Date.now).mockReturnValue(16_000)
  globalError = undefined
  expect(await getGlabKnownHosts()).toEqual(['gitlab.com', 'beta.test'])
})
it.each(
  ['reset', 'stale'].flatMap((retire) => [false, true].map((settled) => ({ retire, settled })))
)('preserves successor ownership: $retire settled=$settled', async ({ retire, settled }) => {
  const old = Promise.withResolvers<{ stdout: string; stderr: string }>()
  execute.mockReturnValueOnce(old.promise)
  const pending = getGlabKnownHosts()
  if (retire === 'reset') {
    _resetKnownHostsCache()
  }
  vi.mocked(Date.now).mockReturnValue(1_000 + PROBE_COALESCE_STALE_MS + 1)
  const next = Promise.withResolvers<{ stdout: string; stderr: string }>()
  execute.mockReturnValueOnce(next.promise)
  const successor = getGlabKnownHosts()
  if (settled) {
    next.reject(failure())
    await successor
  }
  old.reject(failure(login('retired.test')))
  await pending
  const joined = getGlabKnownHosts()
  expect(counts()[0]).toBe(2)
  if (!settled) {
    next.reject(failure())
  }
  await Promise.all([successor, joined])
  expect(getGlabPartialHosts()).toEqual([])
  vi.mocked(Date.now).mockReturnValue(1_000 + PROBE_COALESCE_STALE_MS + 15_000)
  await getGlabKnownHosts()
  expect(counts()[0]).toBe(2)
  vi.mocked(Date.now).mockReturnValue(1_000 + PROBE_COALESCE_STALE_MS + 15_001)
  await getGlabKnownHosts()
  expect(counts()[0]).toBe(3)
})
