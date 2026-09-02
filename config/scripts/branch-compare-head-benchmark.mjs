#!/usr/bin/env node
// Benchmark: the head-of-chain reads in getBranchCompare (src/main/git/status.ts).
//
// Four spawns ran strictly in series before any compare work started: branch
// --show-current, the base-ref probe, rev-parse HEAD, and rev-parse <base>. compareRef is
// display-only metadata and HEAD's oid does not depend on the base ref, so the first three
// can overlap. The probe oid also replaces the fourth spawn when it proves refs/heads/*;
// remote-tracking refs require a raw rev-parse because they may store annotated tags.
//
// This spawns the real git binary against this repo, so it measures actual process-launch
// cost rather than a model of it. Over SSH these are host-local spawns inside the relay,
// so the saving applies to remote spawn time, not to network round trips.
//
// Both arms are compared for identical resolved values before timing.
//
// Run with:  node config/scripts/branch-compare-head-benchmark.mjs
import { execFile } from 'node:child_process'
import { performance } from 'node:perf_hooks'
import { fileURLToPath } from 'node:url'
import { readBranchCompareHead } from '../../src/shared/git-branch-compare-head.ts'

const REPO_ROOT = fileURLToPath(new URL('../..', import.meta.url))
const ITERATIONS = Number(process.env.ORCA_BRANCH_COMPARE_BENCH_ITERATIONS ?? '8')
const WARMUP = Number(process.env.ORCA_BRANCH_COMPARE_BENCH_WARMUP ?? '2')
const ROUNDS = 6

for (const [name, value] of [
  ['ORCA_BRANCH_COMPARE_BENCH_ITERATIONS', ITERATIONS],
  ['ORCA_BRANCH_COMPARE_BENCH_WARMUP', WARMUP]
]) {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer, received ${value}`)
  }
}

function git(args) {
  return new Promise((resolve, reject) => {
    execFile('git', args, { cwd: REPO_ROOT, maxBuffer: 64 * 1024 * 1024 }, (error, stdout) =>
      error ? reject(error) : resolve(stdout.trim())
    )
  })
}

async function probeOid(qualifiedRef) {
  try {
    const out = await git(['rev-parse', '--verify', '--quiet', `${qualifiedRef}^{commit}`])
    return out.length > 0 ? out : null
  } catch {
    return null
  }
}

// Pre-fix: serial chain, and the probe's oid discarded then re-resolved.
async function readSerial(baseRef) {
  const compareRef = (await git(['branch', '--show-current']).catch(() => '')) || 'HEAD'
  let resolvedBaseRef = baseRef
  if (!baseRef.startsWith('refs/')) {
    const candidates = baseRef.includes('/')
      ? [`refs/remotes/${baseRef}`, `refs/heads/${baseRef}`]
      : [`refs/heads/${baseRef}`]
    for (const candidate of candidates) {
      if ((await probeOid(candidate)) !== null) {
        resolvedBaseRef = candidate
        break
      }
    }
  }
  const headOid = await git(['rev-parse', '--verify', '--end-of-options', 'HEAD'])
  const baseOid = await git(['rev-parse', '--verify', '--end-of-options', resolvedBaseRef])
  return { compareRef, resolvedBaseRef, headOid, baseOid }
}

// Production head reader: overlaps independent reads and reuses only safe probe oids.
async function readConcurrent(baseRef) {
  const reusableProbedOidByRef = new Map()
  const resolveBaseRef = async () => {
    if (baseRef.startsWith('refs/')) {
      return baseRef
    }
    const candidates = baseRef.includes('/')
      ? [`refs/remotes/${baseRef}`, `refs/heads/${baseRef}`]
      : [`refs/heads/${baseRef}`]
    for (const candidate of candidates) {
      const oid = await probeOid(candidate)
      if (oid !== null) {
        if (candidate.startsWith('refs/heads/')) {
          reusableProbedOidByRef.set(candidate, oid)
        }
        return candidate
      }
    }
    return baseRef
  }
  const result = await readBranchCompareHead({
    readCompareRef: () =>
      git(['branch', '--show-current'])
        .then((out) => out || 'HEAD')
        .catch(() => 'HEAD'),
    resolveBaseRef,
    readHeadOid: () => git(['rev-parse', '--verify', '--end-of-options', 'HEAD']),
    readBaseOid: (resolvedBaseRef) => {
      const reusableOid = reusableProbedOidByRef.get(resolvedBaseRef)
      return reusableOid === undefined
        ? git(['rev-parse', '--verify', '--end-of-options', resolvedBaseRef])
        : Promise.resolve(reusableOid)
    }
  })
  if (!result.headOidResult.ok) {
    throw result.headOidResult.error
  }
  if (!result.baseOidResult.ok) {
    throw result.baseOidResult.error
  }
  return {
    compareRef: result.compareRef,
    resolvedBaseRef: result.resolvedBaseRef,
    headOid: result.headOidResult.oid,
    baseOid: result.baseOidResult.oid
  }
}

function median(samples) {
  const sorted = [...samples].sort((a, b) => a - b)
  const mid = sorted.length / 2
  return (sorted[mid - 1] + sorted[mid]) / 2
}

async function timeArm(read, baseRef) {
  const start = performance.now()
  for (let index = 0; index < ITERATIONS; index += 1) {
    await read(baseRef)
  }
  return (performance.now() - start) / ITERATIONS
}

// Arms alternate which one leads so within-round drift cannot favour either.
async function measure(baseRef) {
  for (let index = 0; index < WARMUP; index += 1) {
    await readSerial(baseRef)
    await readConcurrent(baseRef)
  }
  const serialSamples = []
  const concurrentSamples = []
  for (let round = 0; round < ROUNDS; round += 1) {
    if (round % 2 === 0) {
      serialSamples.push(await timeArm(readSerial, baseRef))
      concurrentSamples.push(await timeArm(readConcurrent, baseRef))
    } else {
      concurrentSamples.push(await timeArm(readConcurrent, baseRef))
      serialSamples.push(await timeArm(readSerial, baseRef))
    }
  }
  return { serialMs: median(serialSamples), concurrentMs: median(concurrentSamples) }
}

const pad = (value, width) => String(value).padStart(width)
console.log('getBranchCompare head-of-chain reads, per call. Lower is better.')
console.log(`iterations=${ITERATIONS} warmup=${WARMUP} rounds=${ROUNDS} (per-arm medians)`)
console.log(
  `${pad('base ref', 30)} ${pad('serial', 11)} ${pad('concurrent', 11)} ${pad('speedup', 9)}`
)

// A short remote label is the common case (Orca's base picker emits `origin/main`); the
// already-qualified ref skips the probe entirely, so only the concurrency half applies.
const upstream = await git(['rev-parse', '--abbrev-ref', 'HEAD@{upstream}']).catch(() => null)
const baseRefs = ['origin/main', 'refs/remotes/origin/main', 'main']
if (upstream && !baseRefs.includes(upstream)) {
  baseRefs.push(upstream)
}

for (const baseRef of baseRefs) {
  const serial = await readSerial(baseRef)
  const concurrent = await readConcurrent(baseRef)
  if (JSON.stringify(serial) !== JSON.stringify(concurrent)) {
    throw new Error(
      `resolved values differ for ${baseRef}:\n  serial     ${JSON.stringify(serial)}\n  concurrent ${JSON.stringify(concurrent)}`
    )
  }
  if (!serial.headOid) {
    throw new Error(`fixture resolved no HEAD oid for ${baseRef}`)
  }
  const { serialMs, concurrentMs } = await measure(baseRef)
  console.log(
    `${pad(baseRef, 30)} ${pad(`${serialMs.toFixed(1)} ms`, 11)} ${pad(`${concurrentMs.toFixed(1)} ms`, 11)} ${pad(`${(serialMs / concurrentMs).toFixed(2)}x`, 9)}`
  )
}

console.log(
  '\nThe already-qualified refs/... row skips the probe by design, so it only shows the\nconcurrency half. This times the native/WSL head-of-chain reads, not the whole compare;\nthe relay path has separate production-concurrency coverage.'
)
