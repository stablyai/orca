#!/usr/bin/env node
// Replays real Git status through the original and current production parsers.
import { strict as assert } from 'node:assert'
import { createHash } from 'node:crypto'
import { appendFile, mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { performance } from 'node:perf_hooks'
import { fileURLToPath } from 'node:url'
import { runProcess } from '@orca/process-host'
import { build } from 'esbuild'

const checkout = fileURLToPath(new URL('../..', import.meta.url))
const parserPath = 'src/shared/git-status-porcelain-parser.ts'
const baseline =
  process.env.ORCA_STATUS_PARSER_BASE_REF ?? '13a75d3939f60bbc5ebf3bc083fe31fe74813168'
const binary = process.env.ORCA_PERF_GIT_BINARY ?? 'git'
const iterations = Number(process.env.ORCA_STATUS_PARSER_BENCH_ITERATIONS ?? 21)
if (!Number.isSafeInteger(iterations) || iterations < 3) {
  throw new Error('ORCA_STATUS_PARSER_BENCH_ITERATIONS must be an integer of at least 3')
}
const scratch = await mkdtemp(join(tmpdir(), 'orca status parser '))
const env = { ...process.env }
for (const key of Object.keys(env)) {
  if (key.startsWith('GIT_')) {
    delete env[key]
  }
}
Object.assign(env, {
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_CONFIG_GLOBAL: join(scratch, 'empty-config'),
  GIT_TERMINAL_PROMPT: '0'
})
await writeFile(env.GIT_CONFIG_GLOBAL, '')
const statusArgs = [
  '-c',
  'core.quotePath=false',
  'status',
  '--porcelain=v2',
  '--branch',
  '--untracked-files=all'
]

async function git(cwd, args) {
  const result = await runProcess({
    program: binary,
    args,
    cwd,
    env,
    timeoutMs: 30_000,
    maxOutputBytes: 16 * 1024 * 1024
  })
  assert.equal(result.timedOut, false, 'Git timed out')
  assert.notEqual(result.outputTruncated, true, 'Git output exceeded the benchmark cap')
  assert.equal(result.code, 0, result.stderr)
  return result.stdout
}

async function loadParser(source) {
  const bundled = await build({
    stdin: { contents: source, loader: 'ts', resolveDir: resolve(checkout, 'src/shared') },
    bundle: true,
    write: false,
    platform: 'node',
    format: 'esm'
  })
  return import(
    `data:text/javascript;base64,${Buffer.from(bundled.outputFiles[0].text).toString('base64')}`
  )
}

function parse(module, output, limit) {
  const parser = new module.StatusPorcelainParser()
  let stopped = false
  for (let offset = 0; offset < output.length; offset += 4096) {
    if (parser.update(output.slice(offset, offset + 4096), limit)) {
      stopped = true
      break
    }
  }
  if (!stopped) {
    parser.finish()
  }
  return { entries: parser.entries, branch: parser.branch, count: parser.statusLength, stopped }
}

function distribution(samples) {
  const sorted = [...samples].sort((left, right) => left - right)
  return {
    p50: sorted[Math.floor(sorted.length / 2)],
    p95: sorted[Math.ceil(sorted.length * 0.95) - 1]
  }
}

async function paired(run, before, after) {
  for (let index = 0; index < 3; index += 1) {
    await run(before)
    await run(after)
  }
  const samples = [[], []]
  for (let index = 0; index < iterations; index += 1) {
    for (const arm of index % 2 ? [1, 0] : [0, 1]) {
      const started = performance.now()
      await run(arm === 0 ? before : after)
      samples[arm].push(performance.now() - started)
    }
  }
  return { before: distribution(samples[0]), after: distribution(samples[1]), samples }
}

async function writeFixture(cwd, count, extraSpaces) {
  await mkdir(join(cwd, 'old names'), { recursive: true })
  const names = Array.from(
    { length: count },
    (_, index) => `${'long '.repeat(extraSpaces)}a file with spaces ${index}.ts`
  )
  for (let offset = 0; offset < names.length; offset += 32) {
    await Promise.all(
      names
        .slice(offset, offset + 32)
        .map((name, index) =>
          writeFile(join(cwd, 'old names', name), `export const item = ${offset + index}\n`)
        )
    )
  }
  await git(cwd, ['add', '--all'])
  await git(cwd, ['commit', '--quiet', '-m', 'status fixture'])
  for (let offset = 0; offset < names.length; offset += 32) {
    await Promise.all(
      names
        .slice(offset, offset + 32)
        .map((name) => appendFile(join(cwd, 'old names', name), '// modified\n'))
    )
  }
}

const results = []
try {
  const originalSource = await git(checkout, ['show', `${baseline}:${parserPath}`])
  const currentSource = await readFile(join(checkout, parserPath), 'utf8')
  const [before, after] = await Promise.all([loadParser(originalSource), loadParser(currentSource)])
  for (const [count, extraSpaces] of [
    [100, 0],
    [1_000, 0],
    [1_000, 24],
    [10_000, 0]
  ]) {
    const cwd = join(scratch, `repo ${count} spaces ${extraSpaces}`)
    await mkdir(cwd)
    await git(cwd, ['init', '--quiet'])
    await git(cwd, ['symbolic-ref', 'HEAD', 'refs/heads/main'])
    await git(cwd, ['config', 'user.name', 'Orca benchmark'])
    await git(cwd, ['config', 'user.email', 'benchmark@example.invalid'])
    await writeFixture(cwd, count, extraSpaces)
    for (const kind of ['modified', 'renamed']) {
      if (kind === 'renamed') {
        await git(cwd, ['add', '--all'])
        await git(cwd, ['commit', '--quiet', '-m', 'modified fixture'])
        await rename(join(cwd, 'old names'), join(cwd, 'new names'))
        await git(cwd, ['add', '--all'])
      }
      const output = await git(cwd, statusArgs)
      for (const limit of count > 1_000 ? [1_000, 0] : [1_000]) {
        const expected = parse(before, output, limit)
        assert.deepEqual(parse(after, output, limit), expected)
        assert.equal(expected.entries.length, count > limit && limit !== 0 ? limit + 1 : count)
        assert.equal(expected.entries[0].status, kind === 'renamed' ? 'renamed' : 'modified')
        const parser = await paired((module) => parse(module, output, limit), before, after)
        const gitAndParser = await paired(
          async (module) => {
            assert.deepEqual(parse(module, await git(cwd, statusArgs), limit), expected)
          },
          before,
          after
        )
        results.push({
          count,
          extraSpaces,
          kind,
          limit,
          outputBytes: Buffer.byteLength(output),
          parser,
          gitAndParser
        })
        console.log(
          JSON.stringify({
            count,
            extraSpaces,
            kind,
            limit,
            parser: {
              before: parser.before,
              after: parser.after
            },
            gitAndParser: { before: gitAndParser.before, after: gitAndParser.after }
          })
        )
      }
    }
  }
  const report = {
    baseline,
    parserPath,
    node: process.version,
    platform: process.platform,
    architecture: process.arch,
    git: (await git(checkout, ['--version'])).trim(),
    iterations,
    statusArgs,
    chunkCharacters: 4096,
    defaultLimit: 1_000,
    sourceHashes: [originalSource, currentSource].map((source) =>
      createHash('sha256').update(source).digest('hex')
    ),
    results,
    limits:
      'Parser timings isolate CPU. Git-plus-parser includes one real Git child, but no app admission queue, line counts, UI, or SSH transport. Only explicit uncapped requests parse 10,000 rows.'
  }
  if (process.env.ORCA_STATUS_PARSER_BENCH_OUTPUT) {
    await writeFile(
      process.env.ORCA_STATUS_PARSER_BENCH_OUTPUT,
      `${JSON.stringify(report, null, 2)}\n`
    )
  }
} finally {
  await rm(scratch, { recursive: true, force: true })
}
