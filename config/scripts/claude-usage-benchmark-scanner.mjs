import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import { dirname, extname, join, relative, sep } from 'node:path'
import { performance } from 'node:perf_hooks'
import { fileURLToPath } from 'node:url'
import { build, version } from 'esbuild'

const MIB = 1024 * 1024
const ROOT = fileURLToPath(new URL('../..', import.meta.url))
const BASELINE_MODULES = [
  'src/main/claude-usage/scanner.ts',
  'src/main/claude-usage/transcript-record-parser.ts',
  'src/main/claude-usage/usage-aggregation.ts',
  'src/main/claude-usage/worktree-attribution.ts',
  'src/main/claude-usage/transcript-file-discovery.ts'
]

export async function describeClaudeUsageBenchmarkTooling() {
  const paths = [
    'config/scripts/claude-usage-append-benchmark.mjs',
    'config/scripts/claude-usage-benchmark-scanner.mjs',
    'config/scripts/counterbalanced-benchmark-schedule.mjs',
    'src/packages/process-host/src/run-process.ts',
    'src/packages/process-host/dist/run-process.js'
  ]
  return {
    esbuildVersion: version,
    baselineModules: BASELINE_MODULES,
    sha256: Object.fromEntries(
      await Promise.all(
        paths.map(async (path) => [
          path,
          createHash('sha256')
            .update(await readFile(join(ROOT, ...path.split('/'))))
            .digest('hex')
        ])
      )
    )
  }
}

export async function readClaudeUsageBenchmarkBaselineSources() {
  const { runProcessSync } = await import('@orca/process-host')
  const readGit = (args) => {
    const result = runProcessSync({
      program: 'git',
      args,
      cwd: ROOT,
      timeoutMs: 10_000,
      maxOutputBytes: MIB,
      env: { ...process.env, ORCA_BACKGROUND_LAUNCH: '1' }
    })
    assert.equal(result.code, 0, `Git baseline read failed: ${result.stderr}`)
    return result.stdout
  }
  const baselineRef = process.env.ORCA_CLAUDE_USAGE_APPEND_BENCH_BASELINE ?? 'HEAD'
  const baselineCommit = readGit(['rev-parse', '--verify', `${baselineRef}^{commit}`]).trim()
  const sources = new Map(
    BASELINE_MODULES.map((modulePath) => [
      join(ROOT, ...modulePath.split('/')),
      readGit(['show', `${baselineCommit}:${modulePath}`])
    ])
  )
  return { baselineRef, baselineCommit, sources }
}

export async function loadClaudeUsageBenchmarkScanner(
  home,
  baselineSources = new Map(),
  worktreeSources = new Map(),
  baselineCommit = null
) {
  const sourceFingerprints = {}
  const { runProcessSync } = await import('@orca/process-host')
  const result = await build({
    stdin: {
      contents: `export { scanClaudeUsageFiles } from './src/main/claude-usage/scanner';
        export { resetReadMetrics, readMetrics } from 'orca-benchmark-fs';
        export { open as openForBenchmark } from 'node:fs/promises';
        export { createReadStream as createReadStreamForBenchmark } from 'node:fs';`,
      resolveDir: ROOT,
      loader: 'ts'
    },
    platform: 'node',
    format: 'esm',
    bundle: true,
    write: false,
    plugins: [
      {
        name: 'isolated-transcript-filesystem',
        setup(bundler) {
          bundler.onLoad({ filter: /[/\\]src[/\\].*\.[cm]?[jt]sx?$/ }, async (args) => {
            const modulePath = relative(ROOT, args.path).split(sep).join('/')
            if (!modulePath.startsWith('src/')) {
              return undefined
            }
            if (typeof baselineCommit === 'string' && !baselineSources.has(args.path)) {
              const pinned = runProcessSync({
                program: 'git',
                args: ['show', `${String(baselineCommit)}:${modulePath}`],
                cwd: ROOT,
                timeoutMs: 10_000,
                maxOutputBytes: MIB,
                env: { ...process.env, ORCA_BACKGROUND_LAUNCH: '1' }
              })
              assert.equal(pinned.code, 0, `Pinned source read failed: ${pinned.stderr}`)
              assert.equal(pinned.outputTruncated, false, `Pinned source truncated: ${modulePath}`)
              baselineSources.set(args.path, pinned.stdout)
            }
            if (!baselineSources.has(args.path) && !worktreeSources.has(args.path)) {
              worktreeSources.set(args.path, readFile(args.path, 'utf8'))
            }
            const contents =
              baselineSources.get(args.path) ?? (await worktreeSources.get(args.path))
            sourceFingerprints[modulePath] = {
              source: baselineSources.has(args.path)
                ? (baselineCommit ?? 'baseline-map')
                : 'worktree',
              sha256: createHash('sha256').update(contents).digest('hex')
            }
            const extension = extname(args.path).slice(1)
            const loader =
              extension === 'tsx' || extension === 'jsx'
                ? extension
                : extension.endsWith('ts')
                  ? 'ts'
                  : 'js'
            return { contents, loader, resolveDir: dirname(args.path) }
          })
          bundler.onResolve(
            { filter: /^node:(fs(?:\/promises)?|os)$|^orca-benchmark-fs$/ },
            (args) => {
              if (args.path === 'orca-benchmark-fs') {
                return { path: 'node:fs', namespace: 'benchmark' }
              }
              if (args.namespace === 'benchmark') {
                return { path: args.path, external: true }
              }
              return { path: args.path, namespace: 'benchmark' }
            }
          )
          bundler.onResolve({ filter: /claude-profile-installed-router$/ }, () => ({
            path: 'profiles',
            namespace: 'benchmark'
          }))
          bundler.onLoad({ filter: /.*/, namespace: 'benchmark' }, (args) => {
            if (args.path === 'profiles') {
              return { contents: 'export const claudeProfileHistoryDirs = () => [];' }
            }
            if (args.path === 'node:os') {
              return {
                contents: `export * from 'node:os';
                  export const homedir = () => ${JSON.stringify(home)};`
              }
            }
            if (args.path === 'node:fs/promises') {
              return {
                contents: `import * as fs from 'node:fs/promises';
                  import { recordStream, recordRead } from 'orca-benchmark-fs';
                  export * from 'node:fs/promises';
                  export function readFile() {
                    throw new Error('Extend benchmark accounting before using fs.promises.readFile');
                  }
                  export async function open(path, ...args) {
                    const handle = await fs.open(path, ...args);
                    return new Proxy(handle, {
                      get(target, key) {
                        if (key === 'readFile' || key === 'readv') {
                          throw new Error('Extend benchmark accounting before using FileHandle.' + key);
                        }
                        const value = Reflect.get(target, key, target);
                        if (key === 'createReadStream') {
                          return (options) => recordStream(path, options, value.call(target, options));
                        }
                        if (key === 'read') {
                          return async (...readArgs) => {
                            const result = await value.apply(target, readArgs);
                            const options = Buffer.isBuffer(readArgs[0]) ? null : readArgs[0];
                            recordRead(path, options?.position ?? readArgs[3] ?? null, result.bytesRead);
                            return result;
                          };
                        }
                        return typeof value === 'function' ? value.bind(target) : value;
                      }
                    });
                  }`
              }
            }
            return {
              contents: `import * as fs from 'node:fs';
                export * from 'node:fs';
                let reads = [];
                export function readFile() {
                  throw new Error('Extend benchmark accounting before using fs.readFile');
                }
                export function readFileSync() {
                  throw new Error('Extend benchmark accounting before using fs.readFileSync');
                }
                export function recordStream(path, options, stream) {
                  reads.push({ stream, kind: 'stream', path: String(path), start: options?.start ?? 0,
                    end: options?.end ?? null });
                  return stream;
                }
                export function recordRead(path, start, bytes) {
                  reads.push({ kind: 'read', path: String(path), start, bytes });
                }
                export function createReadStream(path, options) {
                  return recordStream(path, options, fs.createReadStream(path, options));
                }
                export function resetReadMetrics() { reads = []; }
                export function readMetrics() {
                  return reads.map(({ stream, ...range }) => ({ ...range, bytes: stream?.bytesRead ?? range.bytes }));
                }`
            }
          })
        }
      }
    ]
  })
  return {
    bundleSha256: createHash('sha256').update(result.outputFiles[0].text).digest('hex'),
    scanner: await import(
      `data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString('base64')}`
    ),
    sourceFingerprints: Object.fromEntries(
      Object.entries(sourceFingerprints).sort(([left], [right]) => left.localeCompare(right))
    )
  }
}

export async function verifyClaudeUsageBenchmarkReadAccounting(scanner, transcriptPath) {
  const payload = Buffer.from('工具結果 🌊'.repeat(5_000))
  await writeFile(transcriptPath, payload)
  scanner.resetReadMetrics()
  const handle = await scanner.openForBenchmark(transcriptPath, 'r')
  try {
    await handle.read(Buffer.alloc(11), 0, 11, 1)
    const stream = handle.createReadStream({ start: 0, end: payload.length - 1, autoClose: false })
    for await (const chunk of stream) {
      void chunk
    }
    const reads = scanner.readMetrics()
    assert.equal(
      reads.reduce((sum, read) => sum + read.bytes, 0),
      payload.length + 11
    )
    assert.equal(reads.filter((read) => read.kind === 'read').length, 1)
    assert.equal(reads.filter((read) => read.kind === 'stream').length, 1)
  } finally {
    await handle.close()
  }
  for await (const chunk of scanner.createReadStreamForBenchmark(transcriptPath)) {
    void chunk
  }
  assert.equal(
    scanner.readMetrics().reduce((sum, read) => sum + read.bytes, 0),
    payload.length * 2 + 11
  )
}

export async function measureClaudeUsageBenchmarkScan(
  scanner,
  transcriptPaths,
  previousProcessedFiles = []
) {
  scanner.resetReadMetrics()
  const start = performance.now()
  const result = await scanner.scanClaudeUsageFiles([], previousProcessedFiles, undefined, [])
  const durationMs = performance.now() - start
  const reads = scanner.readMetrics()
  const allowedPaths = new Set(
    typeof transcriptPaths === 'string' ? [transcriptPaths] : transcriptPaths
  )
  assert(
    reads.every((read) => allowedPaths.has(read.path)),
    'scanner read an unexpected file'
  )
  const serializationStart = performance.now()
  const serializedCache = JSON.stringify(result.processedFiles)
  const cacheSerializationMs = performance.now() - serializationStart
  return {
    result,
    cache: JSON.parse(serializedCache),
    metrics: {
      durationMs,
      cacheSerializationMs,
      totalDurationMs: durationMs + cacheSerializationMs,
      bytesRead: reads.reduce((sum, read) => sum + read.bytes, 0),
      directReadBytes: reads
        .filter((read) => read.kind === 'read')
        .reduce((sum, read) => sum + read.bytes, 0),
      readCount: reads.length,
      streamCount: reads.filter((read) => read.kind === 'stream').length,
      cachedStateBytes: Buffer.byteLength(serializedCache)
    }
  }
}
