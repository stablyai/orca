import { beforeEach, describe, expect, it, vi } from 'vitest'

const {
  runProcessMock,
  resolveCliCommandMock,
  withCliRuntimeOnPathMock,
  resolveRegisteredWorktreePathMock
} = vi.hoisted(() => ({
  runProcessMock: vi.fn(),
  resolveCliCommandMock: vi.fn(),
  withCliRuntimeOnPathMock: vi.fn(),
  resolveRegisteredWorktreePathMock: vi.fn()
}))

vi.mock('../../shared/child-process/run-process', () => ({
  runProcess: runProcessMock
}))
vi.mock('../../shared/node-cli-command-resolution', () => ({
  resolveCliCommand: resolveCliCommandMock,
  withCliRuntimeOnPath: withCliRuntimeOnPathMock
}))
vi.mock('../ipc/registered-worktree-roots-cache', () => ({
  resolveRegisteredWorktreePath: resolveRegisteredWorktreePathMock
}))

const { npmCliPackageView } = await import('./npm-cli-package-view')

const AUTHORIZED_CWD = '/repo/worktree'

function processResult(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    code: 0,
    signal: null,
    stdout: '',
    stderr: '',
    timedOut: false,
    ...overrides
  }
}

const HTTPS_REGISTRY_PROBE = { stdout: 'https://registry.npmjs.org/\n' }

/** Routes the registry probe away from the per-test `npm view` response. */
function mockNpmView(view: ReturnType<typeof processResult>): void {
  runProcessMock.mockImplementation(async (spec: { args: string[] }) =>
    spec.args.includes('config') ? processResult(HTTPS_REGISTRY_PROBE) : view
  )
}

function mockNpmViewError(error: unknown): void {
  runProcessMock.mockImplementation(async (spec: { args: string[] }) => {
    if (spec.args.includes('config')) {
      return processResult(HTTPS_REGISTRY_PROBE)
    }
    throw error
  })
}

/** The spec of the `npm view` spawn, skipping the registry probe. */
function viewSpec(): {
  program: string
  args: string[]
  env: Record<string, string>
  cwd: string
  timeoutMs: number
} {
  const call = runProcessMock.mock.calls.find((c) => (c[0].args as string[]).includes('view'))
  return call![0]
}

function resetMocks(): void {
  runProcessMock.mockReset()
  resolveCliCommandMock.mockReset()
  resolveRegisteredWorktreePathMock.mockReset()
  resolveCliCommandMock.mockReturnValue('/usr/local/bin/npm')
  withCliRuntimeOnPathMock.mockReset()
  // Why passthrough: the real helper only prepends the CLI's own runtime
  // dir to PATH; these tests assert the env pins it wraps, not that.
  withCliRuntimeOnPathMock.mockImplementation((_program, env) => env)
}

describe('npmCliPackageView', () => {
  beforeEach(resetMocks)

  it('resolves the npm binary before spawning, with the exact argv, cwd, env pins and timeout', async () => {
    mockNpmView(processResult({ stdout: JSON.stringify({ name: 'react', version: '19.0.0' }) }))

    await npmCliPackageView('react', AUTHORIZED_CWD)

    expect(resolveCliCommandMock).toHaveBeenCalledWith('npm')
    // Two spawns: the registry probe that refuses a non-https `.npmrc`, then
    // the lookup itself.
    expect(runProcessMock).toHaveBeenCalledTimes(2)
    const spec = viewSpec()
    expect(spec.program).toBe('/usr/local/bin/npm')
    expect(spec.args).toEqual([
      'view',
      '--json',
      '--silent',
      '--',
      'react',
      'description',
      'dist-tags.latest',
      'homepage',
      'version',
      'time',
      'repository'
    ])
    expect(spec.cwd).toBe(AUTHORIZED_CWD)
    expect(spec.timeoutMs).toBe(8000)
    expect(spec.env.COREPACK_ENABLE_AUTO_PIN).toBe('0')
    expect(spec.env.COREPACK_ENABLE_PROJECT_SPEC).toBe('0')
    // Resolution must happen before the spawn, not merely before returning.
    expect(resolveCliCommandMock.mock.invocationCallOrder[0]).toBeLessThan(
      runProcessMock.mock.invocationCallOrder[0]!
    )
  })

  // Why this module must not authorize: the caller resolves the root once,
  // before the cache, because the trust class it derives from that same
  // authorized path is part of the cache key. Re-resolving here would let the
  // cwd npm actually runs in drift from the path trust was checked on.
  it('spawns in the cwd it was given without re-authorizing it', async () => {
    mockNpmView(processResult({ stdout: JSON.stringify({ name: 'react', version: '19.0.0' }) }))

    await npmCliPackageView('react', AUTHORIZED_CWD)

    expect(resolveRegisteredWorktreePathMock).not.toHaveBeenCalled()
    expect(viewSpec().cwd).toBe(AUTHORIZED_CWD)
  })

  it('returns ok with the parsed manifest fields on success', async () => {
    mockNpmView(
      processResult({
        stdout: JSON.stringify({
          name: 'react',
          version: '19.0.0',
          description: 'React library',
          homepage: 'https://react.dev',
          repository: { type: 'git', url: 'git+https://github.com/facebook/react.git' }
        })
      })
    )

    const result = await npmCliPackageView('react', AUTHORIZED_CWD)

    expect(result).toEqual({
      status: 'ok',
      info: {
        packageName: 'react',
        description: 'React library',
        latestVersion: '19.0.0',
        latestPublishedAt: null,
        homepageUrl: 'https://react.dev/',
        repositoryUrl: 'https://github.com/facebook/react.git',
        source: 'npm-cli'
      }
    })
  })

  it('maps npm E404 to not-found', async () => {
    mockNpmView(processResult({ code: 1, stderr: 'npm error code E404\nnpm error 404 Not Found' }))

    const result = await npmCliPackageView('does-not-exist', AUTHORIZED_CWD)

    expect(result).toEqual({ status: 'not-found' })
  })

  it('maps every other non-zero exit to unavailable', async () => {
    mockNpmView(processResult({ code: 1, stderr: 'network unreachable' }))

    const result = await npmCliPackageView('react', AUTHORIZED_CWD)

    expect(result).toEqual({ status: 'unavailable', reason: 'error' })
  })

  it('maps a timed-out probe to unavailable with reason timeout', async () => {
    mockNpmView(processResult({ code: null, timedOut: true }))

    const result = await npmCliPackageView('react', AUTHORIZED_CWD)

    expect(result).toEqual({ status: 'unavailable', reason: 'timeout' })
  })

  it('reports npm-unresolvable when spawning the resolved binary fails with ENOENT', async () => {
    const enoent = Object.assign(new Error('spawn npm ENOENT'), { code: 'ENOENT' })
    mockNpmViewError(enoent)

    const result = await npmCliPackageView('react', AUTHORIZED_CWD)

    expect(result).toEqual({ status: 'npm-unresolvable' })
  })

  it('maps a non-ENOENT spawn failure to unavailable with reason error', async () => {
    mockNpmViewError(new Error('EACCES: permission denied'))

    const result = await npmCliPackageView('react', AUTHORIZED_CWD)

    expect(result).toEqual({ status: 'unavailable', reason: 'error' })
  })
})

describe('npmCliPackageView latest publish date', () => {
  beforeEach(resetMocks)

  // Why: `npm view <pkg> --json` without field selectors returns the latest
  // version's manifest, which carries no publish dates. Requesting `time`
  // explicitly is the only way the CLI path can populate the date the
  // tooltip promises.
  it('requests the time field and maps the latest version publish date', async () => {
    mockNpmView(
      processResult({
        stdout: JSON.stringify({
          description: 'React is a JavaScript library for building user interfaces.',
          'dist-tags.latest': '19.2.8',
          homepage: 'https://react.dev/',
          version: '19.2.8',
          time: {
            created: '2011-10-26T17:46:21.942Z',
            '19.2.7': '2026-07-01T10:00:00.000Z',
            '19.2.8': '2026-08-20T10:00:00.000Z'
          },
          repository: { type: 'git', url: 'git+https://github.com/facebook/react.git' }
        })
      })
    )

    const result = await npmCliPackageView('react', AUTHORIZED_CWD)

    const args = viewSpec().args
    expect(args).toContain('time')
    expect(result).toMatchObject({
      status: 'ok',
      info: {
        latestVersion: '19.2.8',
        latestPublishedAt: '2026-08-20T10:00:00.000Z',
        repositoryUrl: 'https://github.com/facebook/react.git'
      }
    })
  })
})

describe('npmCliPackageView hostile .npmrc containment', () => {
  beforeEach(resetMocks)

  // Why: a project `.npmrc` committed in the repository redirects `npm view`
  // to any host it names, and `${VAR}` substitution pulls values straight from
  // the child environment. Forwarding the whole process env would hand a
  // hostile repository the user's tokens the moment someone hovers.
  it('does not forward arbitrary environment variables to npm', async () => {
    process.env.NPM_TOKEN = 'canary-should-not-leak'
    mockNpmView(processResult({ stdout: 'https://registry.npmjs.org/\n' }))
    await npmCliPackageView('react', AUTHORIZED_CWD)
    const env = viewSpec().env
    delete process.env.NPM_TOKEN
    expect(env.NPM_TOKEN).toBeUndefined()
    expect(env.PATH).toBeDefined()
  })

  // Why still probed after the trust gate: trust says the user vouched for the
  // location, not that every key in its `.npmrc` is safe. Defence in depth.
  it('skips the CLI when the resolved registry is not https', async () => {
    runProcessMock.mockImplementation(async () =>
      processResult({ stdout: 'http://127.0.0.1:59999/\n' })
    )
    const result = await npmCliPackageView('react', AUTHORIZED_CWD)
    expect(result).toEqual({ status: 'npm-unresolvable' })
    // Only the registry probe ran; the lookup itself never did.
    expect(runProcessMock).toHaveBeenCalledTimes(1)
  })
})
