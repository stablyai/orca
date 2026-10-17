#!/usr/bin/env node
// Save the old opencode-usage-row-queries.ts with git show, then run:
// ORCA_BACKGROUND_LAUNCH=1 node --expose-gc config/scripts/opencode-usage-existence-benchmark.mjs --baseline <saved-file> [--rows 100,10000,50000] [--rounds 9] [--output <json-file>]
// Uses real SQLite files, the full migrated OpenCode schema, and both production row reads and database parsing.
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { performance } from 'node:perf_hooks'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'

const root = resolve(import.meta.dirname, '../..')
const productionPath = join(root, 'src/main/opencode-usage/opencode-usage-row-queries.ts')
const args = new Map()
for (let index = 2; index < process.argv.length; index += 2) {
  const name = process.argv[index]
  const value = process.argv[index + 1]
  if (
    !['--baseline', '--rows', '--rounds', '--output'].includes(name) ||
    !value ||
    args.has(name)
  ) {
    throw new Error(`Invalid or duplicate argument: ${name}`)
  }
  args.set(name, value)
}
if (!args.has('--baseline')) {
  throw new Error('--baseline must name a saved baseline opencode-usage-row-queries.ts')
}
const rounds = Number(args.get('--rounds') ?? 9)
const counts = (args.get('--rows') ?? '100,10000').split(',').map(Number)
if (!Number.isSafeInteger(rounds) || rounds < 3 || rounds > 99) {
  throw new Error('--rounds must be an integer between 3 and 99')
}
if (
  counts.length > 5 ||
  counts.some((count) => !Number.isSafeInteger(count) || count < 1 || count > 100_000)
) {
  throw new Error('--rows must contain at most five integers between 1 and 100000')
}
const baselineSource = await readFile(resolve(args.get('--baseline')), 'utf8')
const scratch = await mkdtemp(join(tmpdir(), 'orca-opencode-existence-bench-'))

async function loadVersion(name, source) {
  const outfile = join(scratch, `${name}.cjs`)
  const imports = {
    queries: productionPath,
    database: join(root, 'src/main/sqlite/sync-database.ts'),
    fixture: join(root, 'src/main/opencode-usage/opencode-usage-sqlite-fixture.ts'),
    scanner: join(root, 'src/main/opencode-usage/scanner.ts'),
    resolver: join(root, 'src/main/usage/usage-worktree-resolver.ts')
  }
  await build({
    stdin: {
      contents: `
        export { selectUsageRows } from ${JSON.stringify(imports.queries)};
        export { default as Database } from ${JSON.stringify(imports.database)};
        export { writeOpenCodeUsageDatabase } from ${JSON.stringify(imports.fixture)};
        export { parseOpenCodeUsageDatabase } from ${JSON.stringify(imports.scanner)};
        export { createUsageWorktreeResolver } from ${JSON.stringify(imports.resolver)};`,
      resolveDir: root
    },
    bundle: true,
    platform: 'node',
    format: 'cjs',
    outfile,
    plugins:
      source === undefined
        ? []
        : [
            {
              name: 'saved-baseline-source',
              setup(api) {
                api.onLoad({ filter: /opencode-usage-row-queries\.ts$/ }, () => ({
                  contents: source,
                  loader: 'ts',
                  resolveDir: dirname(productionPath)
                }))
              }
            }
          ]
  })
  return (await import(pathToFileURL(outfile).href)).default
}

function createDatabase(version, file, count, active) {
  version.writeOpenCodeUsageDatabase(file, { generation: 'migrated', worktree: scratch })
  const db = new version.Database(file)
  try {
    db.exec('BEGIN')
    for (const table of ['session', 'session_v2']) {
      const insert = db.prepare(`INSERT INTO ${table}
        (id, project_id, slug, directory, title, version, time_created, time_updated, tokens_input)
        VALUES (?, 'proj-1', 'slug', ?, 'Benchmark session', '1.0.0', ?, ?, ?)`)
      for (let index = 0; index < count; index++) {
        const hasUsage =
          active === 'all' ||
          (active === 'first' && index === 0) ||
          (active === 'last' && index === count - 1)
        insert.run(
          `session-${index.toString().padStart(6, '0')}`,
          scratch,
          1_740_000_000_000 + index,
          1_740_000_060_000 + index,
          hasUsage ? 1000 : 0
        )
      }
    }
    db.exec('COMMIT')
  } finally {
    db.close()
  }
}

function readRows(version, file) {
  const db = new version.Database(file, { readonly: true, fileMustExist: true })
  try {
    db.pragma('query_only = ON')
    return version.selectUsageRows(db)
  } finally {
    db.close()
  }
}

function median(samples) {
  return [...samples].sort((left, right) => left - right)[Math.floor(samples.length / 2)]
}

try {
  const versions = {
    before: await loadVersion('before', baselineSource),
    after: await loadVersion('after')
  }
  const resolvers = {}
  for (const name of ['before', 'after']) {
    resolvers[name] = await versions[name].createUsageWorktreeResolver([
      { repoId: 'benchmark', worktreeId: 'folder', path: scratch, displayName: 'Benchmark folder' }
    ])
  }
  const cases = []
  for (const count of counts) {
    for (const active of ['all', 'first', 'last', 'none']) {
      const file = join(scratch, `${count}-${active}.db`)
      createDatabase(versions.after, file, count, active)
      for (const operation of ['row-read', 'database-parse']) {
        const run = (name) =>
          operation === 'row-read'
            ? readRows(versions[name], file)
            : versions[name].parseOpenCodeUsageDatabase(file, resolvers[name])
        const expected = await run('before')
        assert.deepEqual(await run('after'), expected)
        const samples = { before: [], after: [] }
        for (let round = 0; round < rounds; round++) {
          for (const name of round % 2 === 0 ? ['before', 'after'] : ['after', 'before']) {
            global.gc?.()
            const start = performance.now()
            const result = await run(name)
            samples[name].push(performance.now() - start)
            assert.deepEqual(result, expected)
          }
        }
        const result = {
          count,
          active,
          operation,
          returned: operation === 'row-read' ? expected.length : expected.sessions.length,
          beforeMs: median(samples.before),
          afterMs: median(samples.after),
          samples
        }
        console.log(JSON.stringify(result))
        cases.push(result)
      }
    }
  }
  const result = {
    platform: process.platform,
    arch: process.arch,
    node: process.version,
    rounds,
    forcedGcBetweenSamples: typeof global.gc === 'function',
    cases
  }
  if (args.has('--output')) {
    await writeFile(resolve(args.get('--output')), `${JSON.stringify(result, null, 2)}\n`)
  }
} finally {
  await rm(scratch, { recursive: true, force: true })
}
