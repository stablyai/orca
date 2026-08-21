#!/usr/bin/env node
// Run with: node config/scripts/worktree-base-pending-marker-benchmark.mjs
import fs from 'node:fs'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { syncBuiltinESMExports } from 'node:module'
import os from 'node:os'
import { join } from 'node:path'
import { performance } from 'node:perf_hooks'
import { createJiti } from 'jiti'

const CANDIDATE_COUNT = Number(process.env.ORCA_PENDING_MARKER_BENCH_CANDIDATES ?? '64')
const TOTAL_TICKS = Number(process.env.ORCA_PENDING_MARKER_BENCH_TICKS ?? '900')
const STEADY_TICKS = Number(process.env.ORCA_PENDING_MARKER_BENCH_STEADY_TICKS ?? '300')

for (const [name, value] of [
  ['ORCA_PENDING_MARKER_BENCH_CANDIDATES', CANDIDATE_COUNT],
  ['ORCA_PENDING_MARKER_BENCH_TICKS', TOTAL_TICKS],
  ['ORCA_PENDING_MARKER_BENCH_STEADY_TICKS', STEADY_TICKS]
]) {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer, received ${value}`)
  }
}
if (STEADY_TICKS >= TOTAL_TICKS) {
  throw new Error('ORCA_PENDING_MARKER_BENCH_STEADY_TICKS must be smaller than total ticks')
}

const root = await mkdtemp(join(os.tmpdir(), 'orca-pending-marker-bench-'))
const markerPaths = new Set()
for (let index = 0; index < CANDIDATE_COUNT; index += 1) {
  const candidate = join(root, `ordinary-folder-${index}`)
  await mkdir(candidate)
  markerPaths.add(join(candidate, '.git'))
}

const originalStat = fs.promises.stat
let visibleTick = 0
const markerStatTicks = []
fs.promises.stat = async (path, ...args) => {
  if (markerPaths.has(String(path))) {
    markerStatTicks.push(visibleTick)
  }
  return originalStat(path, ...args)
}
syncBuiltinESMExports()

let poller
let timeout
try {
  const jiti = createJiti(import.meta.url)
  const { startWorktreeBaseDirectoryPoller } = await jiti.import(
    '../../src/main/ipc/worktree-base-directory-poller.ts'
  )
  const repo = { repoId: 'repo-1', repoName: 'repo', nestWorkspaces: false }
  const target = {
    key: `base:local:${root}`,
    kind: 'base',
    path: root,
    repos: new Map([[repo.repoId, repo]])
  }
  let finish
  let fail
  const completed = new Promise((resolve, reject) => {
    finish = resolve
    fail = reject
  })
  timeout = setTimeout(() => fail(new Error('poller benchmark timed out')), 30_000)
  const startedAt = performance.now()
  poller = await startWorktreeBaseDirectoryPoller(
    target,
    () => target.repos,
    () => {},
    {
      pollIntervalMs: 0,
      visibility: {
        isWindowVisible: () => {
          visibleTick += 1
          if (visibleTick > TOTAL_TICKS) {
            finish()
            return false
          }
          return true
        },
        onWindowBecameVisible: () => () => {}
      }
    }
  )
  await completed
  clearTimeout(timeout)
  await poller.unsubscribe()
  poller = undefined

  const steadyStartTick = TOTAL_TICKS - STEADY_TICKS
  const steadyMarkerStats = markerStatTicks.filter((tick) => tick > steadyStartTick).length
  const totalMarkerStats = markerStatTicks.length
  const statsPerCandidateTick = steadyMarkerStats / CANDIDATE_COUNT / STEADY_TICKS
  const elapsedMs = performance.now() - startedAt

  console.log('Worktree-base marker cooldown benchmark. Lower is better.')
  console.log(
    JSON.stringify({
      candidates: CANDIDATE_COUNT,
      totalTicks: TOTAL_TICKS,
      steadyTicks: STEADY_TICKS,
      totalMarkerStats,
      steadyMarkerStats,
      statsPerCandidateTick: Number(statsPerCandidateTick.toFixed(4)),
      elapsedMs: Number(elapsedMs.toFixed(1))
    })
  )
} finally {
  clearTimeout(timeout)
  await poller?.unsubscribe()
  fs.promises.stat = originalStat
  syncBuiltinESMExports()
  await rm(root, { recursive: true, force: true })
}
