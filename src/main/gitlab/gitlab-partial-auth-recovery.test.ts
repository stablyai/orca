import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type * as Ansi from '../../shared/ansi-escape-sequences'
const { git, execute, scan } = vi.hoisted(() => ({ git: vi.fn(), execute: vi.fn(), scan: vi.fn() }))
vi.mock('../git/runner', () => ({ gitExecFileAsync: git, glabExecFileAsync: execute }))
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
  getGlabPartialHosts,
  rememberGlabKnownHosts,
  parseGlabAuthStatusHosts,
  KNOWN_HOSTS_CACHE_MAX_ENTRIES
} from './gitlab-known-host-probe'
import { PROBE_COALESCE_STALE_MS } from '../git/coalesced-probe'
import { NEGATIVE_ENTRY_TTL_MS } from '../git/remote-ref-probe-cache'
const completed = { code: 1, killed: false, signal: null, outputTruncated: false }
const failure = (stderr = '', metadata = {}) =>
  Object.assign(new Error('auth failed'), completed, { stdout: '', stderr }, metadata)
const login = (host: string) => `  ✓ Logged in to ${host} as user (config file)\n`
const fetchIssues = () => listIssues('/repo-pr34184', 20, 'origin')
const counts = () => [
  execute.mock.calls.filter(([a]) => a.length === 2).length,
  execute.mock.calls.filter(([a]) => a[2] === '--hostname').length
]
let globalError: Error | undefined
let hostError: Error | undefined
beforeEach(() => {
  _resetKnownHostsCache()
  _resetProjectRefCache()
  git.mockReset().mockResolvedValue({ stdout: 'https://alpha.test:8443/group/project.git\n' })
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
it.each([false, true])(
  'preserves cached misses and current remote, late facts=%s',
  async (late) => {
    git.mockResolvedValue({ stdout: 'https://beta.test/group/project.git\n' })
    expect((await fetchIssues()).error?.type).toBe('not_found')
    vi.mocked(Date.now).mockReturnValue(15_999)
    expect((await fetchIssues()).error?.type).toBe('not_found')
    expect(counts()).toEqual([1, 1])
    vi.mocked(Date.now).mockReturnValue(16_000)
    globalError = late ? failure(login('beta.test')) : undefined
    const result = await fetchIssues()
    if (!late) {
      expect(result).toMatchObject({ items: [{ number: 7, title: 'Recovered' }], totalPages: 1 })
      expect(execute.mock.lastCall?.[0]).toContain(
        'projects/group%2Fproject/issues?page=1&per_page=20&order_by=updated_at&sort=desc&state=opened'
      )
    } else {
      expect(result.error?.type).toBe('not_found')
      expect(git).toHaveBeenCalledTimes(1)
      git.mockResolvedValue({ stdout: 'https://changed.test/group/project.git\n' })
      vi.mocked(Date.now).mockReturnValue(1_000 + NEGATIVE_ENTRY_TTL_MS)
      expect((await fetchIssues()).error?.type).toBe('not_found')
      expect(git).toHaveBeenCalledTimes(2)
    }
    expect(counts()).toEqual(late ? [3, 2] : [2, 1])
  }
)
it.each([100, 1_000])(
  'bounds global/project work and finite evidence at %i consumers/hosts',
  async (n) => {
    const corpus = `${Array.from({ length: n }, (_, i) => login(`host-${i}.test`)).join('')}${login('alpha.test:8443')}`
    const output =
      n === 100
        ? `${corpus}gitlab.com\n  x gitlab.com: API call failed: 401\n`
        : `${corpus}${login('gitlab.com')}failed.test\n  x failed.test: API call failed: 401\n  ✓ Token found in operating system keyring: ***\n  ! Run glab auth login --hostname failed.test to move it into the operating system keyring.\n`
            .replaceAll('✓', '\u001b[32m✓\u001b[0m')
            .replaceAll('(config file)', '(keyring)')
            .replaceAll('\n', '\r\n')
    globalError = failure(output)
    const burst = () => Promise.all(Array.from({ length: n }, fetchIssues))
    expect((await burst()).every((r) => r.items[0]?.number === 7)).toBe(true)
    await burst()
    expect(counts()).toEqual([1, 1])
    expect(getGlabPartialHosts()).not.toContain(n === 100 ? 'gitlab.com' : 'failed.test')
    expect(scan.mock.calls.map(([bytes]) => bytes)).toEqual([
      output.length + 1,
      'auth failed'.length
    ])
    vi.mocked(Date.now).mockReturnValue(16_000)
    globalError = failure(login('incomplete.test'), { killed: true })
    await burst()
    vi.mocked(Date.now).mockReturnValue(45_999)
    await burst()
    expect(counts()).toEqual([2, 1])
    expect(getGlabPartialHosts()).not.toContain('incomplete.test')
    vi.mocked(Date.now).mockReturnValue(46_000)
    globalError = failure()
    await burst()
    expect(counts()).toEqual([3, 1])
    expect(getGlabPartialHosts()).toContain('alpha.test:8443')
    for (let i = 0; i < KNOWN_HOSTS_CACHE_MAX_ENTRIES; i++) {
      await getGlabKnownHosts(`evict-${i}`)
    }
    expect(getGlabPartialHosts()).toEqual([])
    vi.mocked(Date.now).mockReturnValue(1_000 + NEGATIVE_ENTRY_TTL_MS - 1)
    expect((await burst()).every((r) => r.items[0]?.number === 7)).toBe(true)
    expect(counts()).toEqual([132, 1])
    hostError = failure('alpha.test:8443\n  x alpha.test:8443: API call failed: 401\n')
    vi.mocked(Date.now).mockReturnValue(1_000 + NEGATIVE_ENTRY_TTL_MS)
    await burst()
    expect(counts()).toEqual([132, 2])
    vi.mocked(Date.now).mockReturnValue(2_000_000)
    await burst()
    expect(counts()).toEqual([132, 2])
    expect(scan.mock.calls).toHaveLength(133)
    const parseCalls = scan.mock.calls.length
    const bytes = scan.mock.calls.reduce((sum, [bytes]) => sum + bytes, 0)
    process.stdout.write(`${JSON.stringify({ n, probes: counts(), parseCalls, bytes })}\n`)
  }
)
it.each([{ input: [] }, { input: ['gitlab.com', 'GITLAB.COM'] }, { input: ['alpha.test:8443'] }])(
  'preserves refresh/remember input additions: $input',
  async ({ input }) => {
    await getGlabKnownHosts()
    rememberGlabKnownHosts(input)
    const positive = input.includes('alpha.test:8443')
    expect(await getGlabKnownHosts()).toEqual(
      positive ? ['gitlab.com', 'alpha.test:8443'] : ['gitlab.com']
    )
    expect(counts()[0]).toBe(positive ? 1 : 2)
    globalError = undefined
    vi.mocked(Date.now).mockReturnValue(16_000)
    expect(await getGlabKnownHosts()).toContain('alpha.test:8443')
    rememberGlabKnownHosts([])
    await getGlabKnownHosts()
    expect(counts()[0]).toBe(positive ? 1 : 3)
  }
)
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
it('shares strict login recognition without losing configured headings', () => {
  expect(
    parseGlabAuthStatusHosts(
      'configured.test\n  x API: You must be logged in to forged.test\n  ✓ Logged in to empty.test as \n  ✓ Logged in to source.test as (keyring)\n'
    )
  ).toEqual(['configured.test'])
})
it('keeps the ordinary host-specific success and its retry-stopping remember', async () => {
  hostError = undefined
  expect((await fetchIssues()).items[0]?.number).toBe(7)
  expect(counts()).toEqual([1, 1])
  vi.mocked(Date.now).mockReturnValue(2_000_000)
  expect((await fetchIssues()).items[0]?.number).toBe(7)
  expect(counts()).toEqual([1, 1])
})
