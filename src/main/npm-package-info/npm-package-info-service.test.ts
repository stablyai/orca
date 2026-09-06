import { mkdir, mkdtemp, realpath, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { GlobalSettings } from '../../shared/global-settings-types'
import type { NpmPackageInfoResult } from '../../shared/npm-package-info-types'
import type { Repo } from '../../shared/repo-types'
import type { WorkspaceTrustEntry } from '../../shared/workspace-trust-types'
import type { Store } from '../persistence'

const {
  npmRegistryHttpLookupMock,
  runProcessMock,
  resolveCliCommandMock,
  withCliRuntimeOnPathMock
} = vi.hoisted(() => ({
  npmRegistryHttpLookupMock: vi.fn(),
  runProcessMock: vi.fn(),
  resolveCliCommandMock: vi.fn(),
  withCliRuntimeOnPathMock: vi.fn()
}))

// Only the two boundaries this process cannot cross in a test are faked: the
// subprocess and the network. Authorization, trust resolution and the CLI
// module itself run for real, because a mock of the gate cannot fail where the
// gate fails.
vi.mock('./npm-registry-http-lookup', () => ({
  npmRegistryHttpLookup: npmRegistryHttpLookupMock
}))
vi.mock('../../shared/child-process/run-process', () => ({
  runProcess: runProcessMock
}))
vi.mock('../../shared/node-cli-command-resolution', () => ({
  resolveCliCommand: resolveCliCommandMock,
  withCliRuntimeOnPath: withCliRuntimeOnPathMock
}))

const { createNpmPackageInfoService } = await import('./npm-package-info-service')
const { invalidateAuthorizedRootsCache, registerWorktreeRootsForRepo } =
  await import('../ipc/registered-worktree-roots-cache')

const REPO_ID = 'repo-1'

const okResult: NpmPackageInfoResult = {
  status: 'ok',
  info: {
    packageName: 'react',
    description: null,
    latestVersion: '19.0.0',
    latestPublishedAt: null,
    homepageUrl: null,
    repositoryUrl: null,
    source: 'registry-http'
  }
}

function trustEntry(path: string, trusted: boolean): WorkspaceTrustEntry {
  return { id: `entry-${path}`, path, trusted, decidedAt: 0, origin: 'intake' }
}

function fakeStore(options: {
  settings?: Partial<GlobalSettings>
  repoPath?: string
  entries?: WorkspaceTrustEntry[]
}): Store {
  const repos = options.repoPath
    ? [{ id: REPO_ID, path: options.repoPath, name: 'repo' } as unknown as Repo]
    : []
  return {
    getSettings: () =>
      ({
        ...options.settings,
        workspaceTrustEntries: options.entries ?? []
      }) as GlobalSettings,
    getRepos: () => repos
  } as unknown as Store
}

/** Registers the repo root the way a real repo load does, so authorization runs for real without git. */
function registerRoot(store: Store, root: string): void {
  registerWorktreeRootsForRepo(store, REPO_ID, [root])
}

function processResult(overrides: Partial<Record<string, unknown>> = {}) {
  return { code: 0, signal: null, stdout: '', stderr: '', timedOut: false, ...overrides }
}

const HTTPS_REGISTRY_PROBE = { stdout: 'https://registry.npmjs.org/\n' }
const CLI_MANIFEST = JSON.stringify({
  description: 'React library',
  'dist-tags.latest': '19.1.0',
  version: '19.1.0'
})

/** Routes the registry probe away from the per-test `npm view` response. */
function mockNpmView(view: ReturnType<typeof processResult>): void {
  runProcessMock.mockImplementation(async (spec: { args: string[] }) =>
    spec.args.includes('config') ? processResult(HTTPS_REGISTRY_PROBE) : view
  )
}

function viewSpec(): { cwd: string; args: string[] } {
  const call = runProcessMock.mock.calls.find((c) => (c[0].args as string[]).includes('view'))
  return call![0]
}

/** Realpath'd because macOS `mkdtemp` hands back a `/var` path that is itself a symlink to `/private/var`. */
async function makeRoot(prefix: string): Promise<string> {
  return realpath(await mkdtemp(join(tmpdir(), prefix)))
}

describe('createNpmPackageInfoService', () => {
  beforeEach(() => {
    npmRegistryHttpLookupMock.mockReset()
    runProcessMock.mockReset()
    resolveCliCommandMock.mockReset()
    resolveCliCommandMock.mockReturnValue('/usr/local/bin/npm')
    withCliRuntimeOnPathMock.mockReset()
    withCliRuntimeOnPathMock.mockImplementation((_program, env) => env)
    invalidateAuthorizedRootsCache()
  })

  it('short-circuits to lookup-disabled without any npm or network call when the privacy setting is off', async () => {
    const service = createNpmPackageInfoService(
      fakeStore({ settings: { npmPackageInfoOnlineLookupsEnabled: false } })
    )

    const result = await service.lookup({
      packageName: 'react',
      executionHostId: 'local',
      worktreeRoot: '/repo/worktree'
    })

    expect(result).toEqual({ status: 'lookup-disabled' })
    expect(npmRegistryHttpLookupMock).not.toHaveBeenCalled()
    expect(runProcessMock).not.toHaveBeenCalled()
  })

  // Why every remote host stays on HTTP: a trust entry is a path on this
  // machine, so an SSH or runtime worktree root can never be one. Nothing to
  // gate, and nothing here may run a local npm against a remote path.
  it('routes an ssh host through the registry HTTP path, never the local CLI', async () => {
    npmRegistryHttpLookupMock.mockResolvedValue(okResult)
    const service = createNpmPackageInfoService(fakeStore({}))

    const result = await service.lookup({
      packageName: 'react',
      executionHostId: 'ssh:conn-1',
      worktreeRoot: '/remote/worktree'
    })

    expect(result).toEqual(okResult)
    expect(npmRegistryHttpLookupMock).toHaveBeenCalledWith('react')
    expect(runProcessMock).not.toHaveBeenCalled()
  })

  it('routes a runtime host through the registry HTTP path', async () => {
    npmRegistryHttpLookupMock.mockResolvedValue(okResult)
    const service = createNpmPackageInfoService(fakeStore({}))

    const result = await service.lookup({
      packageName: 'react',
      executionHostId: 'runtime:env-1',
      worktreeRoot: '/remote/worktree'
    })

    expect(result).toEqual(okResult)
    expect(npmRegistryHttpLookupMock).toHaveBeenCalledWith('react')
    expect(runProcessMock).not.toHaveBeenCalled()
  })

  it('sources a trusted local worktree through the npm CLI', async () => {
    const root = await makeRoot('orca-npm-trusted-')
    const store = fakeStore({ repoPath: root, entries: [trustEntry(root, true)] })
    registerRoot(store, root)
    mockNpmView(processResult({ stdout: CLI_MANIFEST }))
    const service = createNpmPackageInfoService(store)

    const result = await service.lookup({
      packageName: 'react',
      executionHostId: 'local',
      worktreeRoot: root
    })

    expect(result).toMatchObject({
      status: 'ok',
      info: { source: 'npm-cli', latestVersion: '19.1.0' }
    })
    expect(npmRegistryHttpLookupMock).not.toHaveBeenCalled()
    expect(viewSpec().cwd).toBe(root)
  })

  it('inherits trust from a trusted ancestor of the worktree root', async () => {
    const parent = await makeRoot('orca-npm-parent-')
    const root = join(parent, 'nested')
    await mkdir(root)
    const store = fakeStore({ repoPath: root, entries: [trustEntry(parent, true)] })
    registerRoot(store, root)
    mockNpmView(processResult({ stdout: CLI_MANIFEST }))
    const service = createNpmPackageInfoService(store)

    const result = await service.lookup({
      packageName: 'react',
      executionHostId: 'local',
      worktreeRoot: root
    })

    expect(result).toMatchObject({ status: 'ok', info: { source: 'npm-cli' } })
  })
})

describe('createNpmPackageInfoService source attribution', () => {
  beforeEach(() => {
    npmRegistryHttpLookupMock.mockReset()
    runProcessMock.mockReset()
    resolveCliCommandMock.mockReset()
    resolveCliCommandMock.mockReturnValue('/usr/local/bin/npm')
    withCliRuntimeOnPathMock.mockReset()
    withCliRuntimeOnPathMock.mockImplementation((_program, env) => env)
    invalidateAuthorizedRootsCache()
  })

  it('degrades a declined local workspace to registry HTTP with the untrusted reason', async () => {
    const root = await makeRoot('orca-npm-declined-')
    const store = fakeStore({ repoPath: root, entries: [trustEntry(root, false)] })
    registerRoot(store, root)
    npmRegistryHttpLookupMock.mockResolvedValue(okResult)
    const service = createNpmPackageInfoService(store)

    const result = await service.lookup({
      packageName: 'react',
      executionHostId: 'local',
      worktreeRoot: root
    })

    expect(result).toEqual({
      status: 'ok',
      info: { ...okResult.info, sourceReason: 'workspace-untrusted' }
    })
    expect(runProcessMock).not.toHaveBeenCalled()
  })

  it('degrades an undecided local workspace the same way a declined one degrades', async () => {
    const root = await makeRoot('orca-npm-undecided-')
    const store = fakeStore({ repoPath: root, entries: [] })
    registerRoot(store, root)
    npmRegistryHttpLookupMock.mockResolvedValue(okResult)
    const service = createNpmPackageInfoService(store)

    const result = await service.lookup({
      packageName: 'react',
      executionHostId: 'local',
      worktreeRoot: root
    })

    expect(result).toMatchObject({ status: 'ok', info: { sourceReason: 'workspace-untrusted' } })
    expect(runProcessMock).not.toHaveBeenCalled()
  })

  // Why a distinct reason: a trusted workspace that fell back because no npm
  // binary exists is a different diagnosis from one that was never trusted.
  it('attributes a trusted fallback to npm being unavailable, not to trust', async () => {
    const root = await makeRoot('orca-npm-nobinary-')
    const store = fakeStore({ repoPath: root, entries: [trustEntry(root, true)] })
    registerRoot(store, root)
    runProcessMock.mockRejectedValue(
      Object.assign(new Error('spawn npm ENOENT'), { code: 'ENOENT' })
    )
    npmRegistryHttpLookupMock.mockResolvedValue(okResult)
    const service = createNpmPackageInfoService(store)

    const result = await service.lookup({
      packageName: 'react',
      executionHostId: 'local',
      worktreeRoot: root
    })

    expect(result).toMatchObject({ status: 'ok', info: { sourceReason: 'npm-unavailable' } })
  })

  // A remote host never had the CLI to lose, so naming a reason would invent a
  // degradation that did not happen.
  it('attributes no reason to a remote host, which has no local trust decision to make', async () => {
    npmRegistryHttpLookupMock.mockResolvedValue(okResult)
    const service = createNpmPackageInfoService(fakeStore({}))

    const result = await service.lookup({
      packageName: 'react',
      executionHostId: 'ssh:conn-1',
      worktreeRoot: '/remote/worktree'
    })

    expect(result).toEqual(okResult)
  })

  it('never mutates the result object the lookup returned', async () => {
    const root = await makeRoot('orca-npm-nomutate-')
    const store = fakeStore({ repoPath: root, entries: [] })
    registerRoot(store, root)
    const shared: NpmPackageInfoResult = { status: 'ok', info: { ...okResult.info } }
    npmRegistryHttpLookupMock.mockResolvedValue(shared)
    const service = createNpmPackageInfoService(store)

    await service.lookup({ packageName: 'react', executionHostId: 'local', worktreeRoot: root })

    expect(shared.status === 'ok' && shared.info.sourceReason).toBeUndefined()
  })

  it('leaves a non-ok result untouched rather than inventing an info object', async () => {
    const root = await makeRoot('orca-npm-notfound-')
    const store = fakeStore({ repoPath: root, entries: [] })
    registerRoot(store, root)
    npmRegistryHttpLookupMock.mockResolvedValue({ status: 'not-found' })
    const service = createNpmPackageInfoService(store)

    const result = await service.lookup({
      packageName: 'nope',
      executionHostId: 'local',
      worktreeRoot: root
    })

    expect(result).toEqual({ status: 'not-found' })
  })
})

describe('createNpmPackageInfoService trust-classed cache key', () => {
  beforeEach(() => {
    npmRegistryHttpLookupMock.mockReset()
    runProcessMock.mockReset()
    resolveCliCommandMock.mockReset()
    resolveCliCommandMock.mockReturnValue('/usr/local/bin/npm')
    withCliRuntimeOnPathMock.mockReset()
    withCliRuntimeOnPathMock.mockImplementation((_program, env) => env)
    invalidateAuthorizedRootsCache()
  })

  // Why the trust class belongs in the key: unlike the privacy flag, a trusted
  // lookup DOES populate the cache, and with private-registry-derived data. A
  // shared key would keep serving it to a workspace whose trust was revoked.
  it('does not serve a stale npm-cli result after trust is revoked', async () => {
    const root = await makeRoot('orca-npm-revoke-')
    const entries = [trustEntry(root, true)]
    const store = fakeStore({ repoPath: root, entries })
    registerRoot(store, root)
    mockNpmView(processResult({ stdout: CLI_MANIFEST }))
    npmRegistryHttpLookupMock.mockResolvedValue(okResult)
    const service = createNpmPackageInfoService(store)
    const request = {
      packageName: 'react',
      executionHostId: 'local' as const,
      worktreeRoot: root
    }

    expect(await service.lookup(request)).toMatchObject({
      status: 'ok',
      info: { source: 'npm-cli' }
    })

    entries.length = 0

    expect(await service.lookup(request)).toMatchObject({
      status: 'ok',
      info: { source: 'registry-http', sourceReason: 'workspace-untrusted' }
    })
  })

  it('does not serve a stale registry-http result after trust is granted', async () => {
    const root = await makeRoot('orca-npm-grant-')
    const entries: WorkspaceTrustEntry[] = []
    const store = fakeStore({ repoPath: root, entries })
    registerRoot(store, root)
    mockNpmView(processResult({ stdout: CLI_MANIFEST }))
    npmRegistryHttpLookupMock.mockResolvedValue(okResult)
    const service = createNpmPackageInfoService(store)
    const request = {
      packageName: 'react',
      executionHostId: 'local' as const,
      worktreeRoot: root
    }

    expect(await service.lookup(request)).toMatchObject({
      status: 'ok',
      info: { source: 'registry-http' }
    })

    entries.push(trustEntry(root, true))

    expect(await service.lookup(request)).toMatchObject({
      status: 'ok',
      info: { source: 'npm-cli' }
    })
  })

  it('keys a CLI entry by class, authorized root, execution host, then package name', async () => {
    const root = await makeRoot('orca-npm-key-')
    const entries = [trustEntry(root, true)]
    const store = fakeStore({ repoPath: root, entries })
    registerRoot(store, root)
    mockNpmView(processResult({ stdout: CLI_MANIFEST }))
    npmRegistryHttpLookupMock.mockResolvedValue(okResult)
    const keys: string[] = []
    const recordingCache = {
      getOrRun: async (key: string, run: () => Promise<NpmPackageInfoResult>) => {
        keys.push(key)
        return run()
      },
      clear: () => undefined
    }
    const service = createNpmPackageInfoService(store, recordingCache)
    const request = {
      packageName: '@scope/pkg',
      executionHostId: 'local' as const,
      worktreeRoot: root
    }

    await service.lookup(request)
    entries.length = 0
    await service.lookup(request)

    // The CLI key carries the authorized root; the HTTP key, which reads no
    // workspace configuration, stays host-scoped.
    expect(keys).toEqual([`cli\0${root}\0local\0@scope/pkg`, 'http\0local\0@scope/pkg'])
  })

  it('keys a remote host as untrusted, so it can never collide with a local CLI entry', async () => {
    npmRegistryHttpLookupMock.mockResolvedValue(okResult)
    const keys: string[] = []
    const recordingCache = {
      getOrRun: async (key: string, run: () => Promise<NpmPackageInfoResult>) => {
        keys.push(key)
        return run()
      },
      clear: () => undefined
    }
    const service = createNpmPackageInfoService(fakeStore({}), recordingCache)

    await service.lookup({
      packageName: 'react',
      executionHostId: 'ssh:conn-1',
      worktreeRoot: '/remote/worktree'
    })

    expect(keys).toEqual(['http\0ssh:conn-1\0react'])
  })
})

/**
 * The design's threat matrix for this gate, one case per boundary. Each runs
 * the real `resolveRegisteredWorktreePath` and the real `isWorkspaceTrusted`
 * against real directories — only the subprocess and the network are faked, so
 * a regression in authorization or trust cannot hide behind a mock of itself.
 */
describe('createNpmPackageInfoService threat matrix', () => {
  beforeEach(() => {
    npmRegistryHttpLookupMock.mockReset()
    npmRegistryHttpLookupMock.mockResolvedValue(okResult)
    runProcessMock.mockReset()
    resolveCliCommandMock.mockReset()
    resolveCliCommandMock.mockReturnValue('/usr/local/bin/npm')
    withCliRuntimeOnPathMock.mockReset()
    withCliRuntimeOnPathMock.mockImplementation((_program, env) => env)
    invalidateAuthorizedRootsCache()
  })

  // Why not merely "unregistered": `resolve()` would reinterpret a relative
  // root against the main process's own cwd — a directory the renderer never
  // named, and one that could well be registered.
  it('rejects a relative worktree root instead of resolving it against the main process cwd', async () => {
    // The registered, trusted root IS what this relative path resolves to from
    // the main process cwd, so only an explicit absoluteness check can refuse it.
    const relative = 'relative/worktree'
    const root = resolve(process.cwd(), relative)
    const store = fakeStore({ repoPath: root, entries: [trustEntry(root, true)] })
    registerRoot(store, root)
    mockNpmView(processResult({ stdout: CLI_MANIFEST }))
    const service = createNpmPackageInfoService(store)

    const result = await service.lookup({
      packageName: 'react',
      executionHostId: 'local',
      worktreeRoot: relative
    })

    expect(result).toEqual({ status: 'unavailable', reason: 'host-unresolved' })
    expect(runProcessMock).not.toHaveBeenCalled()
    expect(npmRegistryHttpLookupMock).not.toHaveBeenCalled()
  })

  it('reports host-unresolved for an absolute path outside every registered root', async () => {
    const root = await makeRoot('orca-npm-registered-')
    const outside = await makeRoot('orca-npm-outside-')
    const store = fakeStore({ repoPath: root, entries: [trustEntry(outside, true)] })
    registerRoot(store, root)
    mockNpmView(processResult({ stdout: CLI_MANIFEST }))
    const service = createNpmPackageInfoService(store)

    const result = await service.lookup({
      packageName: 'react',
      executionHostId: 'local',
      worktreeRoot: outside
    })

    // Trusting a path is not authorizing it: registration is a separate fact.
    expect(result).toEqual({ status: 'unavailable', reason: 'host-unresolved' })
    expect(runProcessMock).not.toHaveBeenCalled()
  })

  // A symlink to a registered root is authorized, and trust is then evaluated
  // on the canonical path the authorization returned — never on the string the
  // renderer sent, which carries no entry of its own.
  it('authorizes a symlink to a registered root and re-verifies trust canonically', async () => {
    const parent = await makeRoot('orca-npm-symlink-')
    const real = join(parent, 'real')
    const link = join(parent, 'link')
    await mkdir(real)
    await symlink(real, link)
    const store = fakeStore({ repoPath: real, entries: [trustEntry(real, true)] })
    registerRoot(store, real)
    mockNpmView(processResult({ stdout: CLI_MANIFEST }))
    const service = createNpmPackageInfoService(store)

    const result = await service.lookup({
      packageName: 'react',
      executionHostId: 'local',
      worktreeRoot: link
    })

    expect(result).toMatchObject({ status: 'ok', info: { source: 'npm-cli' } })
    expect(viewSpec().cwd).toBe(real)
  })

  it('never reaches runProcess for an untrusted workspace, not even to resolve the binary', async () => {
    const root = await makeRoot('orca-npm-nospawn-')
    const store = fakeStore({ repoPath: root, entries: [trustEntry(root, false)] })
    registerRoot(store, root)
    mockNpmView(processResult({ stdout: CLI_MANIFEST }))
    const service = createNpmPackageInfoService(store)

    await service.lookup({ packageName: 'react', executionHostId: 'local', worktreeRoot: root })

    expect(runProcessMock).not.toHaveBeenCalled()
    expect(resolveCliCommandMock).not.toHaveBeenCalled()
  })

  // A host with no npm binary is not a failed lookup: the public registry
  // still answers, so the hover stays useful.
  it('falls back to registry HTTP when spawning npm fails with ENOENT', async () => {
    const root = await makeRoot('orca-npm-enoent-')
    const store = fakeStore({ repoPath: root, entries: [trustEntry(root, true)] })
    registerRoot(store, root)
    runProcessMock.mockRejectedValue(
      Object.assign(new Error('spawn npm ENOENT'), { code: 'ENOENT' })
    )
    const service = createNpmPackageInfoService(store)

    const result = await service.lookup({
      packageName: 'react',
      executionHostId: 'local',
      worktreeRoot: root
    })

    expect(result).toMatchObject({ status: 'ok', info: { source: 'registry-http' } })
    expect(npmRegistryHttpLookupMock).toHaveBeenCalledWith('react')
  })

  // A timeout is not an absent binary: the workspace's own npm answered too
  // slowly, and silently switching registries would hide that.
  it('reports unavailable with reason timeout rather than falling back', async () => {
    const root = await makeRoot('orca-npm-timeout-')
    const store = fakeStore({ repoPath: root, entries: [trustEntry(root, true)] })
    registerRoot(store, root)
    mockNpmView(processResult({ code: null, timedOut: true }))
    const service = createNpmPackageInfoService(store)

    const result = await service.lookup({
      packageName: 'react',
      executionHostId: 'local',
      worktreeRoot: root
    })

    expect(result).toEqual({ status: 'unavailable', reason: 'timeout' })
    expect(npmRegistryHttpLookupMock).not.toHaveBeenCalled()
  })
})

/**
 * Every trusted local worktree shares `executionHostId === 'local'`, but a CLI
 * result is derived from that worktree's own `.npmrc` — which is exactly what a
 * private registry is. The authorized root must therefore be part of the key.
 */
describe('createNpmPackageInfoService per-worktree CLI cache scope', () => {
  beforeEach(() => {
    npmRegistryHttpLookupMock.mockReset()
    runProcessMock.mockReset()
    resolveCliCommandMock.mockReset()
    resolveCliCommandMock.mockReturnValue('/usr/local/bin/npm')
    withCliRuntimeOnPathMock.mockReset()
    withCliRuntimeOnPathMock.mockImplementation((_program, env) => env)
    invalidateAuthorizedRootsCache()
  })

  /** Registers several roots the way a repo with linked worktrees does. */
  function registerRoots(store: Store, roots: string[]): void {
    registerWorktreeRootsForRepo(store, REPO_ID, roots)
  }

  /** One fake `npm view` manifest per cwd, so a shared cache entry is visible in the result. */
  function mockNpmViewByCwd(manifestByCwd: Record<string, string>): void {
    runProcessMock.mockImplementation(async (spec: { args: string[]; cwd: string }) =>
      spec.args.includes('config')
        ? processResult(HTTPS_REGISTRY_PROBE)
        : processResult({ stdout: manifestByCwd[spec.cwd] ?? '{}' })
    )
  }

  it('never serves one trusted worktree the npm-cli result of another', async () => {
    const first = await makeRoot('orca-npm-registry-a-')
    const second = await makeRoot('orca-npm-registry-b-')
    const store = fakeStore({
      repoPath: first,
      entries: [trustEntry(first, true), trustEntry(second, true)]
    })
    registerRoots(store, [first, second])
    mockNpmViewByCwd({
      [first]: JSON.stringify({ 'dist-tags.latest': '1.0.0-private-a', description: 'from a' }),
      [second]: JSON.stringify({ 'dist-tags.latest': '2.0.0-private-b', description: 'from b' })
    })
    const service = createNpmPackageInfoService(store)

    const firstResult = await service.lookup({
      packageName: 'internal-pkg',
      executionHostId: 'local',
      worktreeRoot: first
    })
    const secondResult = await service.lookup({
      packageName: 'internal-pkg',
      executionHostId: 'local',
      worktreeRoot: second
    })

    expect(firstResult).toMatchObject({
      status: 'ok',
      info: { source: 'npm-cli', latestVersion: '1.0.0-private-a', description: 'from a' }
    })
    expect(secondResult).toMatchObject({
      status: 'ok',
      info: { source: 'npm-cli', latestVersion: '2.0.0-private-b', description: 'from b' }
    })
  })

  // Why the HTTP class stays host-keyed: it reads no workspace configuration, so
  // its answer cannot differ between two worktrees on the same host.
  it('still shares one HTTP entry across untrusted worktrees on the same host', async () => {
    const first = await makeRoot('orca-npm-http-a-')
    const second = await makeRoot('orca-npm-http-b-')
    const store = fakeStore({ repoPath: first, entries: [] })
    registerRoots(store, [first, second])
    npmRegistryHttpLookupMock.mockResolvedValue(okResult)
    const service = createNpmPackageInfoService(store)

    await service.lookup({ packageName: 'react', executionHostId: 'local', worktreeRoot: first })
    await service.lookup({ packageName: 'react', executionHostId: 'local', worktreeRoot: second })

    expect(npmRegistryHttpLookupMock).toHaveBeenCalledTimes(1)
  })
})
