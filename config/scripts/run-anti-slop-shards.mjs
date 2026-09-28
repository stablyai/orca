// Why sharded: config/oxlint-anti-slop.json turns every native category off and runs its
// rules through `jsPlugins`, so oxlint's threaded Rust engine does no work and the pass is
// one JS runtime per process. Measured, it does not scale with `--threads` (11.68s at 4 vs
// 12.38s at 16). Parallelism has to come from more processes, so this splits the file set
// across them. Sharding is sound because every anti-slop rule is a single-file analysis: the
// only mutable module state is a WeakMap keyed on each file's own Program node.
//
// Why directory units and not file paths: a shard holds ~7k files, and passing those as argv
// overruns the command-line limit (hard-fails on Windows via CommandLineToArgvW). Whole
// directories keep argv to a few dozen entries, so the splitter recurses only until each unit
// fits the per-shard target.
import { spawn, spawnSync } from 'node:child_process'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { pathToFileURL } from 'node:url'
import { resolveOxlintInvocation } from './oxlint-cli-invocation.mjs'

export const CONFIG = 'config/oxlint-anti-slop.json'
export const ROOTS = ['src', 'config', 'tests', 'mobile']
// Bounds argv growth. Each unit is a path of ~40 chars, so even at this cap a shard stays far
// under the ~32k Windows command-line limit, while leaving room to split a lopsided tree.
const MAX_UNITS = 4096

function shardCount() {
  const requested = Number(process.env.ORCA_ANTI_SLOP_SHARDS)
  if (Number.isInteger(requested) && requested > 0) {
    return requested
  }
  // CPU-seconds grow with shard count, so on a 4-core runner more shards than cores is a
  // measured regression (N=8 was slower than N=4 there). Cap keeps a 64-core dev box sane.
  return Math.max(1, Math.min(os.availableParallelism?.() ?? os.cpus().length, 8))
}

export function listFiles(root = process.cwd()) {
  const { command, prefixArgs } = resolveOxlintInvocation(root)
  const result = spawnSync(
    command,
    [...prefixArgs, '--config', CONFIG, ...ROOTS, '--debug=files'],
    {
      cwd: root,
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024
    }
  )
  if (result.status !== 0) {
    process.stderr.write(result.stderr ?? '')
    throw new Error(`oxlint --debug=files exited with ${result.status}`)
  }
  return result.stdout
    .split('\n')
    .map((line) => line.trim().replace(/^\.\//, ''))
    .filter(Boolean)
}

// Splits the largest unit into its children until every unit fits `target`. A directory's own
// direct files become individual units so the parent stays fully covered after a split.
export function buildUnits(files, target) {
  const units = new Map()
  for (const file of files) {
    const top = file.split('/')[0]
    if (!units.has(top)) {
      units.set(top, [])
    }
    units.get(top).push(file)
  }

  while (units.size < MAX_UNITS) {
    let biggest
    for (const [unit, unitFiles] of units) {
      // A unit that is already a single file cannot be split further.
      if (unitFiles.length <= target || unitFiles.length <= 1) {
        continue
      }
      if (!biggest || unitFiles.length > units.get(biggest).length) {
        biggest = unit
      }
    }
    if (!biggest) {
      break
    }

    const depth = biggest.split('/').length
    const children = new Map()
    for (const file of units.get(biggest)) {
      const segments = file.split('/')
      // Files sitting directly in the split directory have no deeper segment to group by.
      const key = segments.length > depth ? segments.slice(0, depth + 1).join('/') : file
      if (!children.has(key)) {
        children.set(key, [])
      }
      children.get(key).push(file)
    }
    // A single child means every file shares the next segment (src/renderer -> src/renderer/src).
    // Replacing the unit with it still deepens the path, so the next pass can split further.
    units.delete(biggest)
    for (const [key, childFiles] of children) {
      units.set(key, childFiles)
    }
  }

  return [...units.entries()].map(([unit, unitFiles]) => ({ unit, count: unitFiles.length }))
}

// Largest-first into the least-loaded shard: keeps the slowest shard close to the mean, which
// is what the wall time is bound by.
export function packShards(units, shards) {
  const bins = Array.from({ length: shards }, () => ({ units: [], count: 0 }))
  for (const unit of [...units].sort((a, b) => b.count - a.count)) {
    const lightest = bins.reduce((best, bin) => (bin.count < best.count ? bin : best), bins[0])
    lightest.units.push(unit.unit)
    lightest.count += unit.count
  }
  return bins.filter((bin) => bin.units.length > 0)
}

function runShard(units, root) {
  const { command, prefixArgs } = resolveOxlintInvocation(root)
  return new Promise((resolve) => {
    const child = spawn(
      command,
      [
        ...prefixArgs,
        '--config',
        CONFIG,
        '--deny-warnings',
        ...units.map((unit) => path.normalize(unit))
      ],
      { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] }
    )
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk) => {
      stdout += chunk
    })
    child.stderr.on('data', (chunk) => {
      stderr += chunk
    })
    child.on('error', (error) =>
      resolve({ status: 1, stdout, stderr: `${stderr}${error.message}\n` })
    )
    child.on('close', (status) => resolve({ status: status ?? 1, stdout, stderr }))
  })
}

// Keeps a shard's paths well inside the ~32k Windows command-line limit. Splitting finer buys
// balance but costs argv, so this is the ceiling the planner degrades against.
const ARGV_BUDGET = 16_000

// Plans the shards for a file list: exported so a test can assert the units stay disjoint and
// complete, which is what makes the union of shard findings equal to a single pass.
export function planShards(files, shards) {
  let divisor = shards
  let plan
  // A deeper split means more units and a longer argv. If the tree is lopsided enough that the
  // fine split would overrun the budget, back off to coarser units and accept the imbalance
  // rather than handing the OS a command line it will reject.
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const units = buildUnits(files, Math.ceil(files.length / Math.max(divisor, 1)))
    const bins = packShards(units, shards)
    plan = { units, bins }
    const widest = bins.reduce((max, bin) => Math.max(max, bin.units.join(' ').length), 0)
    if (widest <= ARGV_BUDGET || divisor <= 1) {
      break
    }
    divisor = Math.floor(divisor / 2)
  }
  return plan
}

async function main() {
  const root = process.cwd()
  const files = listFiles(root)
  const shards = Math.min(shardCount(), files.length || 1)
  const { units, bins } = planShards(files, shards)

  console.log(
    `anti-slop: ${files.length} files across ${bins.length} shard(s) (${units.length} units): ${bins
      .map((bin) => bin.count)
      .join(', ')}`
  )

  // Printed in shard order rather than completion order so the log is reproducible.
  const results = await Promise.all(bins.map((bin) => runShard(bin.units, root)))
  let failed = false
  for (const result of results) {
    if (result.stdout) {
      process.stdout.write(result.stdout)
    }
    if (result.stderr) {
      process.stderr.write(result.stderr)
    }
    if (result.status !== 0) {
      failed = true
    }
  }

  if (failed) {
    process.exitCode = 1
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main()
}
