import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { dirname, extname, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build, version } from 'esbuild'
import { runProcessSync } from '@orca/process-host'

const ROOT = fileURLToPath(new URL('../..', import.meta.url))
const MIB = 1024 * 1024

export function claudeBenchmarkSha256(value) {
  return createHash('sha256').update(value).digest('hex')
}

export function resolveClaudeBenchmarkCommit(ref) {
  const result = runProcessSync({
    program: 'git',
    args: ['rev-parse', '--verify', `${ref}^{commit}`],
    cwd: ROOT,
    timeoutMs: 10_000,
    maxOutputBytes: MIB,
    env: { ...process.env, ORCA_BACKGROUND_LAUNCH: '1' }
  })
  assert.equal(result.code, 0, result.stderr)
  return result.stdout.trim()
}

function persistenceEntry(mode) {
  const exports = [
    `export { UsageCacheSnapshotWriter } from './src/main/usage-cache-snapshot-writer';`,
    `export { UsageProviderStoreLifecycle } from './src/main/usage/usage-provider-store-lifecycle';`
  ]
  if (mode === 'published') {
    exports.push(`export { validatePersistedClaudeUsageProjections }
      from './src/main/claude-usage/persisted-projection-validation';`)
  } else if (mode === 'main') {
    exports.push(`export { readUsageSourceCache as readSourceCache,
      writeUsageSourceCache as writeSourceCache, splitUsageCacheFile as splitCacheFile }
      from './src/main/usage/usage-source-cache-file';`)
  } else {
    exports.push(`export { readClaudeUsageSourceCache as readSourceCache,
      writeClaudeUsageSourceCache as writeSourceCache, persistClaudeUsageSourceCache as persistSourceCache,
      splitClaudeUsageCacheFile as splitCacheFile }
      from './src/main/claude-usage/persisted-source-cache';
      export { parseClaudeUsageReport as parseReport, serializeClaudeUsageReport as serializeReport }
      from './src/main/claude-usage/persisted-usage-report';
      export { encodeClaudeUsagePersistedState }
      from './src/main/claude-usage/persisted-token-columns';`)
  }
  return exports.join('\n')
}

const INACTIVE_LIFECYCLE_IMPORTS = new Map([
  [
    'agent-token-usage-reporter',
    'export class AgentTokenUsageReporter { constructor() { throw new Error("Inactive telemetry reached"); } }'
  ],
  [
    'analytics-session-id-store',
    'export class AnalyticsSessionIdStore { constructor() { throw new Error("Inactive analytics reached"); } }'
  ],
  ['telemetry/client', 'export const isTelemetryEnabled = () => false;'],
  [
    'usage-worktree-metadata',
    'export const loadKnownUsageWorktreesByRepo = () => { throw new Error("Startup accessed worktrees"); };'
  ]
])

export async function loadClaudeUsageBenchmarkPersistence(mode, commit = null, frozen = new Map()) {
  const sourceFingerprints = {}
  const stubFingerprints = {}
  const result = await build({
    stdin: { contents: persistenceEntry(mode), loader: 'ts', resolveDir: ROOT },
    platform: 'node',
    format: 'esm',
    bundle: true,
    write: false,
    plugins: [
      {
        name: 'pinned-usage-persistence',
        setup(bundler) {
          bundler.onResolve(
            {
              filter:
                /agent-token-usage-reporter$|analytics-session-id-store$|telemetry\/client$|usage-worktree-metadata$/
            },
            (args) => {
              const match = [...INACTIVE_LIFECYCLE_IMPORTS.keys()].find((path) =>
                args.path.endsWith(path)
              )
              return match ? { path: match, namespace: 'inactive-lifecycle' } : undefined
            }
          )
          bundler.onLoad({ filter: /.*/, namespace: 'inactive-lifecycle' }, (args) => {
            const contents = INACTIVE_LIFECYCLE_IMPORTS.get(args.path)
            stubFingerprints[args.path] = claudeBenchmarkSha256(contents)
            return { contents, loader: 'js' }
          })
          bundler.onLoad({ filter: /[/\\]src[/\\].*\.[cm]?[jt]sx?$/ }, async ({ path }) => {
            const modulePath = relative(ROOT, path).split(sep).join('/')
            if (!modulePath.startsWith('src/')) {
              return undefined
            }
            if (!frozen.has(path)) {
              if (typeof commit === 'string') {
                const pinned = runProcessSync({
                  program: 'git',
                  args: ['show', `${String(commit)}:${modulePath}`],
                  cwd: ROOT,
                  timeoutMs: 10_000,
                  maxOutputBytes: MIB,
                  env: { ...process.env, ORCA_BACKGROUND_LAUNCH: '1' }
                })
                assert.equal(pinned.code, 0, pinned.stderr)
                assert.equal(pinned.outputTruncated, false, modulePath)
                frozen.set(path, pinned.stdout)
              } else {
                frozen.set(path, readFile(path, 'utf8'))
              }
            }
            const contents = await frozen.get(path)
            sourceFingerprints[modulePath] = {
              source: commit ?? 'worktree',
              sha256: claudeBenchmarkSha256(contents)
            }
            const extension = extname(path).slice(1)
            const loader =
              extension === 'tsx' || extension === 'jsx'
                ? extension
                : extension.endsWith('ts')
                  ? 'ts'
                  : 'js'
            return { contents, loader, resolveDir: dirname(path) }
          })
        }
      }
    ]
  })
  const code = result.outputFiles[0].text
  return {
    module: await import(`data:text/javascript;base64,${Buffer.from(code).toString('base64')}`),
    moduleUrl: `data:text/javascript;base64,${Buffer.from(code).toString('base64')}`,
    bundleSha256: claudeBenchmarkSha256(code),
    esbuildVersion: version,
    sourceFingerprints: Object.fromEntries(Object.entries(sourceFingerprints).sort()),
    stubFingerprints
  }
}

export function claudeBenchmarkState(result, schemaVersion = 6) {
  return {
    schemaVersion,
    worktreeFingerprint: '[]',
    processedFiles: result.processedFiles,
    sessions: result.sessions,
    dailyAggregates: result.dailyAggregates,
    scanState: { enabled: false, lastScanStartedAt: 1, lastScanCompletedAt: 2, lastScanError: null }
  }
}

export function serializeClaudeBenchmarkReport(arm, state) {
  if (arm.mode === 'current') {
    return arm.persistence.module.serializeReport(state)
  }
  if (arm.mode === 'published') {
    return JSON.stringify(state)
  }
  const { processedFiles: _sources, ...report } = state
  return JSON.stringify(report)
}

export function createClaudeBenchmarkStore(arm, cacheFile, splitCacheFile, parseReport) {
  const implementation = arm.persistence.module
  class BenchmarkStore extends implementation.UsageProviderStoreLifecycle {
    constructor() {
      super(
        { getRepos: () => [], getAllWorktreeMeta: () => ({}) },
        {
          logTag: '[claude-persistence-benchmark]',
          resolveCacheFile: () => cacheFile,
          createDefaultState: () =>
            claudeBenchmarkState(
              { processedFiles: [], sessions: [], dailyAggregates: [] },
              arm.mode === 'current' ? 7 : 6
            ),
          normalizeState:
            arm.mode === 'published'
              ? implementation.validatePersistedClaudeUsageProjections
              : (state) => state,
          sourceKey: 'processedFiles',
          dataPresenceKey: 'hasAnyClaudeData',
          scan: async () => {
            throw new Error('Startup initiated a scan')
          },
          splitCacheFile,
          ...(arm.mode === 'current'
            ? {
                providerId: 'claude',
                parseReport: parseReport ?? implementation.parseReport,
                serializeReport: implementation.serializeReport
              }
            : {})
        }
      )
    }
    reportState() {
      return this.state
    }
  }
  return new BenchmarkStore()
}
