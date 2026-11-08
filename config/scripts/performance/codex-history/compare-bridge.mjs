import { build } from 'esbuild'
import { execFileSync } from 'node:child_process'
import { mkdtemp, mkdir, writeFile, link, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { performance, monitorEventLoopDelay } from 'node:perf_hooks'
import { createRequire } from 'node:module'

const root = resolve(import.meta.dirname, '../../../..')
const count = Number(process.env.BENCH_SESSIONS ?? 10000)
const runs = Number(process.env.BENCH_RUNS ?? 5)
const base = process.env.BENCH_BASE ?? 'origin/main'
if (!Number.isInteger(count) || count < 1 || !Number.isInteger(runs) || runs < 1) {
  throw new Error('BENCH_SESSIONS and BENCH_RUNS must be positive integers')
}
const temp = await mkdtemp(join(tmpdir(), 'orca-bridge-bench-'))
const sourcePath = 'src/main/codex/history/bridges/codex-account-session-bridge.ts'
try {
  const archive = join(temp, 'base.tar')
  execFileSync('git', ['archive', '--output', archive, base, 'src'], { cwd: root })
  const baseDir = join(temp, 'base')
  await mkdir(baseDir)
  execFileSync('tar', ['-xf', archive, '-C', baseDir])
  const modules = []
  for (const [name, dir] of [
    ['base', baseDir],
    ['working', root]
  ]) {
    const outfile = join(temp, `${name}.cjs`)
    await build({
      entryPoints: [join(dir, sourcePath)],
      outfile,
      bundle: true,
      platform: 'node',
      format: 'cjs',
      plugins: [
        {
          name: 'isolate-bridge',
          setup(builder) {
            builder.onResolve(
              { filter: /codex-account-session-index-heal$|codex-state-db$/ },
              () => ({ path: 'stub', namespace: 'benchmark' })
            )
            builder.onLoad({ filter: /.*/, namespace: 'benchmark' }, () => ({
              contents:
                'export const createCodexAccountStateDb = null, healCodexAccountSessionIndex = null, countCodexSessionFilesUpTo = null, findNewestCodexStateDbPath = null, readCodexStateDbBackfillStatus = null'
            }))
          }
        }
      ]
    })
    modules.push([name, createRequire(import.meta.url)(outfile).bridgeCodexSessionsIntoAccountHome])
  }
  const source = join(temp, 'source')
  for (let i = 0; i < count; i++) {
    const dir = join(
      source,
      'sessions',
      '2025',
      String(1 + Math.floor(i / 2800)).padStart(2, '0'),
      String(1 + (Math.floor(i / 100) % 28)).padStart(2, '0')
    )
    await mkdir(dir, { recursive: true })
    const id = `${i.toString(16).padStart(8, '0')}-0000-4000-8000-000000000000`
    await writeFile(join(dir, `rollout-2025-01-01T00-00-00-${id}.jsonl`), '{}\n')
  }
  const { readdir } = await import('node:fs/promises')
  async function populate(src, dst) {
    await mkdir(dst, { recursive: true })
    for (const entry of await readdir(src, { withFileTypes: true })) {
      await (entry.isDirectory()
        ? populate(join(src, entry.name), join(dst, entry.name))
        : link(join(src, entry.name), join(dst, entry.name)))
    }
  }
  console.log(
    JSON.stringify({
      base,
      baseCommit: execFileSync('git', ['rev-parse', base], { cwd: root, encoding: 'utf8' }).trim(),
      count,
      runs,
      node: process.version,
      platform: process.platform,
      note: 'Synthetic local fixtures; warm OS cache; excludes DB healing and startup'
    })
  )
  for (const scenario of ['existing', 'missing']) {
    for (let run = 0; run < runs; run++) {
      for (const [name, bridge] of run % 2 ? modules.toReversed() : modules) {
        const target = join(temp, `target-${name}-${scenario}-${run}`)
        if (scenario === 'existing') {
          await populate(join(source, 'sessions'), join(target, 'sessions'))
        }
        const delay = monitorEventLoopDelay({ resolution: 10 })
        delay.enable()
        await new Promise((r) => setTimeout(r, 20))
        const cpu = process.cpuUsage()
        const start = performance.now()
        const result = await bridge({
          sourceCodexHomePaths: [source],
          targetCodexHomePath: target,
          hardlinkOnly: true
        })
        const ms = performance.now() - start
        const usage = process.cpuUsage(cpu)
        await new Promise((r) => setTimeout(r, 20))
        delay.disable()
        if (
          result.scannedFiles !== count ||
          result.skippedFiles !== 0 ||
          result.bridgedThreads.size !== count ||
          result.linkedFiles !== (scenario === 'missing' ? count : 0)
        ) {
          throw new Error(
            `Unexpected result: ${JSON.stringify({ ...result, bridgedThreads: result.bridgedThreads.size })}`
          )
        }
        console.log(
          JSON.stringify({
            scenario,
            run: run + 1,
            version: name,
            ms: +ms.toFixed(1),
            cpuMs: +((usage.user + usage.system) / 1000).toFixed(1),
            maxLoopDelayMs: +(delay.max / 1e6).toFixed(1),
            scanned: result.scannedFiles,
            linked: result.linkedFiles
          })
        )
        await rm(target, { recursive: true, force: true })
      }
    }
  }
} finally {
  await rm(temp, { recursive: true, force: true })
}
