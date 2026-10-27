import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { pathToFileURL } from 'node:url'
import { createContext, runInContext } from 'node:vm'
import ts from 'typescript-api'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Repo } from '../../shared/repo-types'
import type { WorktreeMeta } from '../../shared/worktree/meta-types'
import type { GitWorktreeInfo } from '../../shared/worktree/types'

const { pruneLineageMock, pruneMetadataMock } = vi.hoisted(() => ({
  pruneLineageMock: vi.fn(),
  pruneMetadataMock: vi
    .fn()
    .mockResolvedValue({ scanGenerationCurrent: true, preservedMetadataCandidateIds: new Set() })
}))
vi.mock('../worktree-lineage-pruning', () => ({
  pruneLineageForMissingRepoWorktrees: pruneLineageMock
}))
vi.mock(
  '../ipc/worktrees/listing/authoritative-local-worktree-metadata-pruning',
  async (importOriginal) => ({
    ...(await importOriginal<Record<string, unknown>>()),
    pruneMetadataMissingFromAuthoritativeLocalScan: pruneMetadataMock
  })
)
const { hiddenHostIds } = vi.hoisted(() => ({ hiddenHostIds: new Set<string>() }))
vi.mock('./runtime-visible-catalog', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  runtimeHiddenHostIds: () => hiddenHostIds
}))
vi.mock('../project-runtime-git-options', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getLocalProjectWorktreeGitOptions: () => ({})
}))

import { RuntimeManagedWorktreeQueries } from './runtime-managed-worktree-queries'
import type { RuntimeStore } from './runtime-store-contract'
import {
  bumpLocalWorktreeScanGeneration,
  getLocalWorktreeScanGeneration,
  resetLocalWorktreeScanGenerationsForTests
} from '../local-worktree-scan-generation'
import type { HostWorktreeTarget } from '../../shared/worktree/host-qualified-identity'

const settings = {
  workspaceDir: '/worktrees',
  nestWorkspaces: true,
  refreshLocalBaseRefOnWorktreeCreate: false,
  branchPrefix: 'none',
  branchPrefixCustom: ''
}

function folderRepo(overrides: Partial<Repo> = {}): Repo {
  return {
    id: 'repo-1',
    path: '/workspace/app',
    displayName: 'Local app',
    badgeColor: '#000000',
    addedAt: 1,
    kind: 'folder',
    ...overrides
  }
}

function metadata(overrides: Partial<WorktreeMeta> = {}): WorktreeMeta {
  return {
    displayName: '',
    comment: '',
    linkedIssue: null,
    linkedPR: null,
    linkedLinearIssue: null,
    isArchived: false,
    isUnread: false,
    isPinned: false,
    sortOrder: 0,
    lastActivityAt: 0,
    ...overrides
  }
}

function queries(
  store: RuntimeStore,
  overrides: Partial<ConstructorParameters<typeof RuntimeManagedWorktreeQueries>[0]> = {}
): RuntimeManagedWorktreeQueries {
  return new RuntimeManagedWorktreeQueries({
    getStore: () => store,
    listResolved: async () => [],
    resolveRepo: async () => store.getRepos()[0]!,
    selectRepos: () => store.getRepos(),
    scanRepo: async () => ({ ok: true, worktrees: [] }),
    listKnownHostIds: () => [],
    ...overrides
  })
}

describe('RuntimeManagedWorktreeQueries.listDetected', () => {
  it('stamps a scanned listing with the generation its scan began at', async () => {
    resetLocalWorktreeScanGenerationsForTests()
    const repo = folderRepo({ kind: 'git', path: '/source/git-app' })
    const store = {
      getRepos: () => [repo],
      getRepo: () => repo,
      getAllWorktreeMeta: () => ({}),
      getWorktreeMeta: () => undefined,
      setWorktreeMeta: vi.fn(),
      getAllWorktreeLineage: () => ({}),
      getSettings: () => settings
    } as unknown as RuntimeStore
    const atScanStart = getLocalWorktreeScanGeneration(repo.id)
    const scanRepo = vi.fn(async () => {
      // A mutation lands after the scan settles; the listing still names the catalog it scanned.
      return { ok: true as const, worktrees: [] }
    })

    const listing = await queries(store, { scanRepo }).listDetected(repo)
    bumpLocalWorktreeScanGeneration(repo.id)

    expect(listing.authoritative).toBe(true)
    expect(listing.catalogVersion?.sequence).toBe(atScanStart)
    expect(listing.catalogVersion?.epoch).toEqual(expect.any(String))
    expect(getLocalWorktreeScanGeneration(repo.id)).toBeGreaterThan(atScanStart)
  })

  it("does not project another host's folder metadata", async () => {
    const local = folderRepo()
    const remote = folderRepo({ connectionId: 'build-box', displayName: 'Remote app' })
    const rootId = `${local.id}::${local.path}`
    const foreignMeta = metadata({ displayName: 'Wrong host', hostId: 'ssh:build-box' })
    const store = {
      getRepos: () => [local, remote],
      getRepo: () => local,
      getAllWorktreeMeta: () => ({ [rootId]: foreignMeta }),
      getWorktreeMeta: () => foreignMeta,
      setWorktreeMeta: vi.fn(),
      getAllWorktreeLineage: () => ({}),
      getSettings: () => settings
    } as unknown as RuntimeStore

    const result = await queries(store).listDetected(local)

    expect(result.worktrees).toHaveLength(1)
    expect(result.worktrees[0]).toMatchObject({
      id: rootId,
      hostId: 'local',
      displayName: 'Local app'
    })
  })

  it('omits host-owned source defaults for clients that do not support them', async () => {
    const repo = folderRepo({ path: '/source/app' })
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: a partial store mock; the code under test reads only the members it defines.
    const store = {
      getRepos: () => [repo],
      getRepo: () => repo,
      getAllWorktreeMeta: () => ({}),
      getWorktreeMeta: () => undefined,
      setWorktreeMeta: vi.fn((_target: HostWorktreeTarget, updates) => metadata(updates)),
      getAllWorktreeLineage: () => ({}),
      getSettings: () => ({
        ...settings,
        worktreeVisibilityDefaults: {
          external: 'show' as const,
          customSources: [{ id: 'host-source', rootPath: '/source' }],
          sourcePreferences: { custom: { 'host-source': 'show' as const } }
        }
      })
    } as unknown as RuntimeStore

    const current = await queries(store).listDetected(repo, true)
    const legacy = await queries(store).listDetected(repo, false)

    expect(current.worktrees[0]).toMatchObject({
      visibilitySource: { kind: 'custom', id: 'host-source' }
    })
    expect(legacy.worktrees[0]).not.toHaveProperty('visibilitySource')
  })
})

describe('RuntimeManagedWorktreeQueries.list host scope', () => {
  // Scoped SSH refusal must report coverage gaps; empty hostIds/omissions formerly looked like a successful empty repo despite the unscoped refusal.
  function sshStore(): RuntimeStore {
    const repo = folderRepo({
      id: 'repo-ssh',
      kind: 'git',
      connectionId: 'conn-1',
      path: '/home/dev/app'
    })
    return {
      getRepos: () => [repo],
      getRepo: () => repo,
      getAllWorktreeMeta: () => ({}),
      getWorktreeMeta: () => undefined,
      setWorktreeMeta: vi.fn(),
      getAllWorktreeLineage: () => ({}),
      getSettings: () => settings
    } as unknown as RuntimeStore
  }

  it('names the scoped repo host as omitted when the listing covered nothing', async () => {
    const result = await queries(sshStore()).list('repo-ssh', 50)

    expect(result.totalCount).toBe(0)
    expect(result.hostScope).toEqual({
      hostIds: [],
      omittedHostIds: ['ssh:conn-1']
    })
  })

  // A selector still resolves a converted host's retained repo; its host must not leak back out.
  it('never names a hidden host, even for a selector that resolves to its repo', async () => {
    hiddenHostIds.add('ssh:conn-1')
    try {
      const result = await queries(sshStore()).list('repo-ssh', 50)
      expect(result.hostScope?.omittedHostIds).toEqual([])
    } finally {
      hiddenHostIds.clear()
    }
  })

  it('does not report the scoped host as omitted once it contributes rows', async () => {
    const store = sshStore()
    const result = await queries(store, {
      listResolved: async () =>
        [
          {
            id: 'repo-ssh::/home/dev/app',
            repoId: 'repo-ssh',
            path: '/home/dev/app',
            hostId: 'ssh:conn-1'
          }
        ] as never
    }).list('repo-ssh', 50)

    expect(result.hostScope?.hostIds).toEqual(['ssh:conn-1'])
    expect(result.hostScope?.omittedHostIds).toEqual([])
  })

  // The caller scoped the listing, so the hosts they excluded must not come back as gaps.
  it('never names a host the caller scoped out', async () => {
    const scoped = await queries(sshStore(), {
      listKnownHostIds: () => ['local', 'ssh:other', 'runtime:elsewhere'] as never
    }).list('repo-ssh', 50)

    expect(scoped.hostScope?.omittedHostIds).toEqual(['ssh:conn-1'])
  })

  // Check both host spellings so scoped coverage names the actual execution host.
  it('names the local host for a scoped local repo', async () => {
    const repo = folderRepo({ id: 'repo-local', kind: 'git', path: '/workspace/local' })
    const store = {
      getRepos: () => [repo],
      getRepo: () => repo,
      getAllWorktreeMeta: () => ({}),
      getWorktreeMeta: () => undefined,
      setWorktreeMeta: vi.fn(),
      getAllWorktreeLineage: () => ({}),
      getSettings: () => settings
    } as unknown as RuntimeStore

    const result = await queries(store).list('repo-local', 50)

    expect(result.hostScope?.omittedHostIds).toEqual(['local'])
  })

  it('prefers executionHostId over connectionId for the scoped host', async () => {
    const repo = folderRepo({
      id: 'repo-runtime',
      kind: 'git',
      connectionId: 'conn-legacy',
      executionHostId: 'runtime:env-1',
      path: '/workspace/runtime'
    })
    const store = {
      getRepos: () => [repo],
      getRepo: () => repo,
      getAllWorktreeMeta: () => ({}),
      getWorktreeMeta: () => undefined,
      setWorktreeMeta: vi.fn(),
      getAllWorktreeLineage: () => ({}),
      getSettings: () => settings
    } as unknown as RuntimeStore

    const result = await queries(store).list('repo-runtime', 50)

    expect(result.hostScope?.omittedHostIds).toEqual(['runtime:env-1'])
  })

  it('still reports every configured host when the listing is unscoped', async () => {
    const unscoped = await queries(sshStore(), {
      listKnownHostIds: () => ['local', 'ssh:conn-1'] as never
    }).list(undefined, 50)

    expect(unscoped.hostScope?.omittedHostIds).toEqual(['local', 'ssh:conn-1'])
  })
})

describe('RuntimeManagedWorktreeQueries.listDetected overtaken scan', () => {
  const repo = folderRepo({ kind: 'git' })
  const created = '/worktrees/created'

  function rows(paths: readonly string[]): GitWorktreeInfo[] {
    return paths.map((path) => ({
      path,
      head: 'abc',
      branch: 'main',
      isBare: false,
      isMainWorktree: path === repo.path
    }))
  }

  function gitStore(overrides: Record<string, unknown> = {}): RuntimeStore {
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the git listing reads only these store members; the prunes that would need more are mocked above.
    return {
      getRepos: () => [repo],
      getRepo: () => repo,
      getAllWorktreeMeta: () => ({}),
      getWorktreeMeta: () => undefined,
      setWorktreeMeta: vi.fn(),
      getAllWorktreeLineage: () => ({}),
      getSettings: () => settings,
      ...overrides
    } as unknown as RuntimeStore
  }

  /** A scan a worktree change lands under: the generation moves before the rows come back. */
  function overtakenScan(paths: readonly string[]) {
    return async () => {
      bumpLocalWorktreeScanGeneration(repo.id)
      return { ok: true as const, worktrees: rows(paths) }
    }
  }

  beforeEach(() => {
    resetLocalWorktreeScanGenerationsForTests()
    pruneLineageMock.mockClear()
    pruneMetadataMock.mockClear()
  })

  it('re-runs a scan a worktree change overtook and publishes the second scan as authoritative', async () => {
    const scanRepo = vi
      .fn()
      .mockImplementationOnce(overtakenScan([repo.path]))
      .mockResolvedValueOnce({ ok: true, worktrees: rows([repo.path, created]) })

    const result = await queries(gitStore(), { scanRepo }).listDetected(repo)

    expect(scanRepo).toHaveBeenCalledTimes(2)
    expect(result).toMatchObject({ authoritative: true, source: 'git' })
    expect(result.worktrees.map((worktree) => worktree.path)).toEqual([repo.path, created])
    // The overtaken rows omit the created worktree; only the settled rows may prune.
    expect(pruneLineageMock).toHaveBeenCalledTimes(1)
    expect(pruneLineageMock.mock.calls[0]?.[2]).toEqual(rows([repo.path, created]))
  })

  it('prunes metadata against the expectation and generation of the scan it publishes', async () => {
    const expectations: unknown[] = []
    const generations: number[] = []
    const store = gitStore({
      pruneSessionlessMissingLocalWorktreeMetadataForRepo: vi.fn(() => []),
      getProfileStorageDirectory: () => '/profile',
      captureNativeLocalWorktreeMetadataScanExpectation: vi.fn(() => {
        const expectation = { repo, metadata: [] }
        expectations.push(expectation)
        generations.push(getLocalWorktreeScanGeneration(repo.id))
        return expectation
      })
    })
    const scanRepo = vi
      .fn()
      .mockImplementationOnce(overtakenScan([repo.path]))
      .mockResolvedValueOnce({ ok: true, worktrees: rows([repo.path, created]) })

    await queries(store, { scanRepo }).listDetected(repo)

    expect(expectations).toHaveLength(2)
    expect(pruneMetadataMock).toHaveBeenCalledTimes(1)
    expect(pruneMetadataMock.mock.calls[0]?.[0]).toMatchObject({
      scan: expectations[1],
      scanGeneration: generations[1],
      gitWorktrees: rows([repo.path, created])
    })
  })

  it('publishes the last scan non-authoritatively once the re-scan bound is spent', async () => {
    const scanRepo = vi.fn(overtakenScan([repo.path]))

    const result = await queries(gitStore(), { scanRepo }).listDetected(repo)

    // One scan plus the two re-runs the bound allows.
    expect(scanRepo).toHaveBeenCalledTimes(3)
    expect(result).toMatchObject({ authoritative: false, source: 'git' })
    expect(result.unavailableReason).toBeUndefined()
    expect(result.failureKind).toBeUndefined()
    expect(result.worktrees.map((worktree) => worktree.path)).toEqual([repo.path])
    expect(pruneLineageMock).not.toHaveBeenCalled()
    expect(pruneMetadataMock).not.toHaveBeenCalled()
  })

  it('does not re-run a failed scan the change overtook', async () => {
    const scanRepo = vi.fn(async () => {
      bumpLocalWorktreeScanGeneration(repo.id)
      return { ok: false as const, worktrees: [] }
    })

    const result = await queries(gitStore(), { scanRepo }).listDetected(repo)

    expect(scanRepo).toHaveBeenCalledTimes(1)
    expect(result).toMatchObject({ authoritative: false, source: 'metadata-fallback' })
  })
})

// Real-source VM instrumentation spans 3 shapes at 100/1000 rows across 3 publication/listing routes.
it('bounds publication and listing to base work plus one linear nesting pass', async () => {
  const home = mkdtempSync(join(tmpdir(), 'orca-pr29328-contract-'))
  const root = process.cwd()
  const native = createRequire(join(root, 'package.json'))
  const env = { ...process.env }
  for (const key of 'HOME USERPROFILE XDG_CONFIG_HOME XDG_DATA_HOME XDG_CACHE_HOME XDG_STATE_HOME CLAUDE_CONFIG_DIR CODEX_HOME ORCA_E2E_USER_DATA_DIR ORCA_E2E_HOME_DIR'.split(
    ' '
  )) {
    env[key] = home
  }
  Object.assign(env, { ORCA_BACKGROUND_LAUNCH: '1', ORCA_DISABLE_MACOS_LOGIN_SHELL: '1' })
  const globals =
    'Buffer URL URLSearchParams TextEncoder TextDecoder structuredClone performance console setTimeout clearTimeout setInterval clearInterval setImmediate clearImmediate'
  const context = createContext({
    __metadata: metadata,
    __join: join,
    process: { ...process, env },
    ORCA_BUILD_COMMIT: '0'.repeat(40),
    ORCA_FEATURE_WALL_ENABLED: true,
    __equal: (actual: unknown, expected: unknown) => expect(actual).toEqual(expected),
    __bound: (actual: number, limit: number, label: string) =>
      expect.soft(actual, label).toBeLessThanOrEqual(limit)
  })
  Object.entries(Object.getOwnPropertyDescriptors(globalThis))
    .filter(([name]) => globals.split(' ').includes(name))
    .forEach(([name, descriptor]) => Object.defineProperty(context, name, descriptor))
  const modules = new Map<string, { exports: unknown }>()
  const exists = (file: string) => statSync(join(root, file), { throwIfNoEntry: false })?.isFile()
  const suffixes = ['', '.ts', '.tsx', '.js', '.mjs', '/index.ts', '/index.js']
  const sourcePath = (file: string) => suffixes.map((suffix) => file + suffix).find(exists)
  function load(file: string): unknown {
    const cached = modules.get(file)
    if (cached) {
      return cached.exports
    }
    const filename = join(root, file)
    const directory = dirname(filename)
    const source = readFileSync(filename, 'utf8')
    if (file.endsWith('.json')) {
      return JSON.parse(source)
    }
    if (file === 'src/main/runtime/orca-runtime-read-kitty-file.ts') {
      return { OrcaRuntimeWithReadKittyFile: class {} }
    }
    const module = { exports: {} }
    modules.set(file, module)
    const parsed = ts.createSourceFile(file, source, ts.ScriptTarget.ES2022, true)
    const edits: [number, number, string][] = []
    const insert = (at: number, text: string) => edits.push([at, at, text])
    const lineage = /(?:resolved-worktree-lineage|worktree-lineage-host-peers)\.ts$/.test(file)
    const passes =
      /^(resolveWorktreeLineageParents|projectResolvedWorktreeLineage|projectPublishedWorktreeLineage|getConnectedWorktreeLineageIds|getCyclicLineageChildKeys)$/
    const visit = (node: ts.Node): void => {
      if (ts.isMetaProperty(node) && node.keywordToken === ts.SyntaxKind.ImportKeyword) {
        edits.push([node.getStart(parsed), node.end, '__moduleMeta'])
      }
      if (ts.isObjectLiteralExpression(node) && node.properties.some(ts.isSpreadAssignment)) {
        insert(node.getStart(parsed), '__copy(')
        insert(node.end, ')')
      }
      if (lineage && ts.isIterationStatement(node, false)) {
        const body = node.statement
        if (ts.isBlock(body)) {
          insert(body.getStart(parsed) + 1, `__hit('resolverSteps');`)
        } else {
          insert(body.getStart(parsed), `{__hit('resolverSteps');`)
          insert(body.end, '}')
        }
      }
      if (ts.isFunctionDeclaration(node) && node.body) {
        const name = node.name?.text ?? ''
        if (name === 'readWorktreeLineageCorpus' || (lineage && passes.test(name))) {
          const metric =
            name === 'readWorktreeLineageCorpus' ? 'corpusAcquisitions' : 'resolverPasses'
          insert(node.body.getStart(parsed) + 1, `__hit('${metric}');`)
        }
      }
      ts.forEachChild(node, visit)
    }
    visit(parsed)
    let marked = source
    for (const [start, end, text] of edits.sort((a, b) => b[0] - a[0])) {
      marked = marked.slice(0, start) + text + marked.slice(end)
    }
    const output = ts.transpileModule(marked, {
      compilerOptions: {
        module: ts.ModuleKind.CommonJS,
        target: ts.ScriptTarget.ES2022,
        esModuleInterop: true
      }
    }).outputText
    const requireSource = (specifier: string): unknown => {
      if (/^(node:)?(process|os)$/.test(specifier)) {
        return specifier.endsWith('os')
          ? { ...native('node:os'), homedir: () => home }
          : context.process
      }
      const candidate = relative(root, resolve(directory, specifier)).replaceAll(sep, '/')
      const local = specifier.startsWith('.') ? sourcePath(candidate) : undefined
      const absolute = local ? join(root, local) : native.resolve(specifier, { paths: [directory] })
      const tracked = relative(root, absolute).replaceAll(sep, '/')
      return /^(src|packages)\//.test(tracked) && exists(tracked) ? load(tracked) : native(absolute)
    }
    const moduleMeta = JSON.stringify({ url: pathToFileURL(filename).href })
    const invoke: unknown = runInContext(
      `(function(require,module,exports,__filename,__dirname){'use strict';const __moduleMeta=${moduleMeta};${output}\n})`,
      context,
      { filename: file }
    )
    if (typeof invoke !== 'function') {
      throw new Error('Invalid source wrapper')
    }
    Object.assign(requireSource, { resolve: native.resolve })
    invoke(requireSource, module, module.exports, filename, directory)
    return module.exports
  }
  Object.assign(context, { __load: load })
  try {
    await runInContext(
      `(async () => {
      const metrics = 'storeReads metadataRowsVisited resolverPasses resolverSteps rowCopies mapBuilds mapEntries'.split(' ');
      const counts = {};
      let active = false;
      globalThis.__hit = (key, amount = 1) => { if (active) counts[key] = (counts[key] ?? 0) + amount; };
      const measure = async action => {
        for (const key of [...metrics, 'corpusAcquisitions', 'workspaceMapReads']) counts[key] = 0;
        active = true;
        try { return { rows: await action(), sample: { ...counts } }; } finally { active = false; }
      };
      const NativeMap = Map;
      globalThis.Map = class extends NativeMap {
        constructor(...args) { super(...args); __hit('mapBuilds'); }
        set(key, value) { __hit('mapEntries'); return super.set(key, value); }
      };
      globalThis.__copy = row => { __hit('rowCopies'); return row; };
      const assign = Object.assign;
      Object.assign = (...args) => { __hit('rowCopies'); return assign(...args); };
      const fromEntries = Object.fromEntries;
      Object.fromEntries = entries => {
        __hit('mapBuilds');
        function* counted() { for (const entry of entries) { __hit('mapEntries'); yield entry; } }
        return fromEntries(counted());
      };
      const { setAppEnvironment } = __load('src/shared/app-environment.ts');
      setAppEnvironment({ getPath: () => process.env.HOME, getAppPath: () => ${JSON.stringify(root)},
        getVersion: () => '0.0.0-contract', isPackaged: () => false,
        onWillQuit() {}, getAppMetrics: () => [], exit() { throw Error('Unexpected runtime exit'); } });
      const { getDefaultPersistedState } = __load('src/shared/constants.ts');
      const { Store } = __load('src/main/persistence/loading-store/store.ts');
      const { RuntimeWorkspaceCatalog } = __load('src/main/runtime/workspaces/workspace-catalog.ts');
      const { RuntimeResolvedWorktreeCache } = __load('src/main/runtime/runtime-resolved-worktree-cache.ts');
      const { WorkspaceRowsProducer } = __load('src/main/runtime/sidebar-inputs/workspace-rows-producer.ts');
      const { RuntimeManagedWorktreeQueries } = __load('src/main/runtime/runtime-managed-worktree-queries.ts');
      const { canonicalWorktreeIdentity } = __load('src/shared/worktree/identity.ts');
      const host = __load('src/shared/worktree/host-qualified-identity.ts');
      const { getProjectHostSetupWorktreeMeta } = __load('src/shared/project-host-setup-lookup.ts');
      // Pinned MAIN 5a2d2f49 actual trigger vectors: catalog | listing | synchronous producer.
      const baselines = {
        "zero:100": "503 200 2 0 60801 6 300|800 100 300 200 91000 900 400|205 200 2 0 31301 910 2800",
        "zero:1000": "5003 2000 2 0 6008001 6 3000|8000 1000 3000 2000 9010000 9000 4000|2005 2000 2 0 3013001 9010 28000",
        "pair:100": "505 202 2 4 60801 7 304|806 104 300 518 91604 904 710|205 200 2 4 31301 911 2804",
        "pair:1000": "5005 2002 2 4 6008001 7 3004|8006 1004 3000 5018 9016004 9004 7010|2005 2000 2 4 3013001 9011 28004",
        "chain:100": "701 398 2 396 60801 105 696|1198 10198 300 99400 140800 6049 69800|205 200 2 396 31301 1009 3196",
        "chain:1000": "7001 3998 2 3996 6008001 1005 6996|11998 1001998 3000 9994000 14008000 510499 6998000|2005 2000 2 3996 3013001 10009 31996"
      };
      const proxies = new WeakMap();
      function observe(result, metric) {
        if (!proxies.has(result)) proxies.set(result, new Proxy(result, {
          ownKeys(target) {
            const keys = Reflect.ownKeys(target);
            __hit(metric, keys.length);
            return keys;
          },
          get(target, key) {
            if (Object.hasOwn(target, key) && (!Array.isArray(target) || /^\\d+$/.test(String(key))))
              __hit(metric);
            return target[key];
          }
        }));
        return proxies.get(result);
      }
      for (const shape of ['zero', 'pair', 'chain']) {
        for (const n of [100, 1000]) {
          const state = getDefaultPersistedState(process.env.HOME);
          state.settings.localWindowsRuntimeDefault = { kind: 'windows-host' };
          state.settings.worktreeVisibilityDefaults.external = 'show';
          state.repos = Array.from({ length: n }, (_, i) => ({ id: 'scaling-' + i,
            path: __join(process.env.HOME, 'repo-' + i), displayName: 'Repo ' + i,
            badgeColor: 'blue', addedAt: 1, executionHostId: 'local' }));
          state.worktreeMetaByIdentity = {};
          state.worktreeIdentityAliases = {};
          const ids = state.repos.map(repo => repo.id + '::' + repo.path);
          for (const [i, id] of ids.entries()) {
            const instanceId = 'instance-' + i;
            const meta = __metadata({ displayName: 'Repo ' + i, instanceId, hostId: 'local' });
            state.worktreeMeta[id] = meta;
            const key = canonicalWorktreeIdentity({ worktreeId: id, executionHostId: 'local', instanceId });
            state.worktreeMetaByIdentity[key] = meta;
            state.worktreeIdentityAliases[host.composeWorktreeHostIdentity('local', id)] = [key];
            if (i > 0 && (shape === 'chain' || (shape === 'pair' && i === 1)))
              state.worktreeLineageById[id] = { worktreeId: id, worktreeInstanceId: instanceId,
                parentWorktreeId: ids[i - 1], parentWorktreeInstanceId: 'instance-' + (i - 1),
                origin: 'manual', capture: { source: 'manual-action', confidence: 'explicit' }, createdAt: 1 };
          }
          const store = new Store({ serializedState: JSON.stringify(state),
            dataFile: __join(process.env.HOME, shape + '-' + n, 'orca-data.json') });
          const setups = store.getProjectHostSetups();
          for (const repo of store.getRepos()) store.setWorktreeMeta(
            host.hostWorktreeTarget({ id: repo.id + '::' + repo.path, hostId: 'local' }),
            getProjectHostSetupWorktreeMeta(setups, repo));
          const reads = ['getRepos', 'getAllWorktreeMeta', 'getWorktreeLineageMetadata',
            'getAllWorktreeMetaForHost', 'getWorktreeMeta', 'getWorktreeMetaForHost',
            'getAllWorktreeLineage', 'getAllWorkspaceLineage'];
          for (const name of reads) {
            const original = store[name];
            store[name] = (...args) => {
              const result = original.apply(store, args);
              __hit('storeReads');
              if (name === 'getAllWorkspaceLineage') __hit('workspaceMapReads');
              const singular = /^(getWorktreeMeta|getWorktreeMetaForHost)$/.test(name);
              if (singular && result !== undefined) __hit('metadataRowsVisited');
              if (singular || name === 'getRepos' || result === null || typeof result !== 'object')
                return result;
              return /Lineage/.test(name) && name !== 'getWorktreeLineageMetadata'
                ? result : observe(result, 'metadataRowsVisited');
            };
          }
          const repos = store.getRepos();
          const scan = async repo => ({ ok: true, worktrees: [{ path: repo.path,
            head: 'abc1234', branch: 'main', isBare: false, isMainWorktree: true }] });
          const catalog = Object.assign(Object.create(RuntimeWorkspaceCatalog.prototype), {
            store, worktreeScanCache: new Map(), resolvedWorktrees: new RuntimeResolvedWorktreeCache(),
            requireStore: () => store, listRepoWorktreesForListing: scan });
          const listing = new RuntimeManagedWorktreeQueries({ getStore: () => store,
            listResolved: () => catalog.listResolvedWorktrees(), resolveRepo: async () => repos[0],
            selectRepos: () => repos, scanRepo: scan, listKnownHostIds: () => ['local'] });
          const check = (rows, feed = false) => {
            __equal(rows.map(row => row.id), ids);
            rows.forEach((row, i) => {
              const parent = i > 0 && (shape === 'chain' || (shape === 'pair' && i === 1));
              __equal((feed ? row.lineage?.parentWorktreeId : row.parentWorktreeId) ?? null,
                parent ? ids[i - 1] : null);
              if (!feed) __equal(row.childWorktreeIds ?? [],
                (shape === 'chain' && i < n - 1) || (shape === 'pair' && i === 0) ? [ids[i + 1]] : []);
            });
          };
          const detected = async () => {
            const rows = [];
            for (const repo of repos) {
              const result = await listing.listDetected(repo);
              __equal(result.authoritative, true);
              rows.push(...result.worktrees);
            }
            return rows;
          };
          const producer = new WorkspaceRowsProducer({ store, onClientEvent: () => () => {},
            scan: () => catalog.scanResolvedWorktreeRepos(),
            join: scans => catalog.joinResolvedWorktreeScans(scans), visible: snapshot => snapshot });
          await producer.ready();
          const published = () => {
            producer.revision.bump();
            return Object.values(producer.snapshot().rows);
          };
          check(await catalog.listResolvedWorktrees());
          check(await detected());
          catalog.resolvedWorktrees.invalidateResolved();
          for (const [route, action] of [() => catalog.listResolvedWorktrees(), detected, published].entries()) {
            const { rows, sample } = await measure(async () => await action());
            check(rows, route === 2);
            const base = baselines[shape + ':' + n].split('|')[route].split(' ').map(Number);
            for (const key of ['storeReads', 'metadataRowsVisited', 'rowCopies', 'mapBuilds', 'mapEntries'])
              __equal(sample[key] > 0, true);
            if (shape !== 'zero') __equal(sample.resolverPasses > 0, true);
            // One corpus contributes 3N metadata visits and 4N+E map entries; final projection adds the rest.
            const allowance = route !== 1 ? [3, 3*n, 1, 2*n, 0, 16, 15*n+1]
              : [n, shape === 'pair' ? 1 : n-1, 0, n, 0, 0, 0];
            metrics.forEach((key, i) => __bound(sample[key], base[i] + (shape === 'zero' ? 0 : allowance[i]),
              shape + '/' + n + '/' + route + '/' + key));
            __bound(sample.corpusAcquisitions, shape !== 'zero' && route !== 1 ? 1 : 0, 'one corpus');
            if (route === 1) __bound(sample.workspaceMapReads, n, 'one workspace map per listing');
          }
        }
      }
    })()`,
      context
    )
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
}, 120_000)
