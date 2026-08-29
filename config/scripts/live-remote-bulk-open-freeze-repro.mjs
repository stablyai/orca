#!/usr/bin/env node
/**
 * Live freeze repro against a running Orca desktop + paired remote runtime.
 *
 * Models bulk-open of remote sessions under multi-worktree load.
 *
 * Usage:
 *   node config/scripts/live-remote-bulk-open-freeze-repro.mjs
 *   ORCA_FREEZE_ENV=paired-remote ORCA_FREEZE_CREATE=12 ORCA_FREEZE_SWITCH_PASSES=5 \
 *     ORCA_FREEZE_PARALLEL=8 node config/scripts/live-remote-bulk-open-freeze-repro.mjs
 */
import { spawnSync } from 'node:child_process'
import { mkdirSync, writeFileSync, copyFileSync } from 'node:fs'
import path from 'node:path'
import { BoundedLiveFreezeHistory } from './live-freeze-bounded-history.mjs'
import {
  applySwitchTargetCap,
  DEFAULT_HARD_MS,
  DEFAULT_SOFT_MS,
  evaluateFreezeSignals,
  extractTerminalHandle,
  readFreezeNumberEnv,
  shouldCapSwitchTargets,
  worktreeSelector
} from './live-remote-bulk-open-freeze-metrics.mjs'
import { createOrcaRpc } from './live-remote-freeze-rpc.mjs'

const root = path.resolve(import.meta.dirname, '../..')
const reportDir = path.join(root, 'test-results', 'freeze-repro')
const envName = process.env.ORCA_FREEZE_ENV || 'paired-remote'
const createCount = Math.max(0, readFreezeNumberEnv('ORCA_FREEZE_CREATE', 0))
const switchPasses = Math.max(1, readFreezeNumberEnv('ORCA_FREEZE_SWITCH_PASSES', 3))
const parallel = Math.max(1, readFreezeNumberEnv('ORCA_FREEZE_PARALLEL', 1))
// 0 = no cap (use all live terminals). Only positive env values limit targets.
const maxSwitchTargets = Math.max(0, readFreezeNumberEnv('ORCA_FREEZE_MAX_SWITCH_TARGETS', 0))
const softMs = readFreezeNumberEnv('ORCA_FREEZE_SOFT_MS', DEFAULT_SOFT_MS)
const hardMs = readFreezeNumberEnv('ORCA_FREEZE_HARD_MS', DEFAULT_HARD_MS)
const createWorktreeSpan = Math.max(1, readFreezeNumberEnv('ORCA_FREEZE_CREATE_WT_SPAN', 16))
const preFloodMs = Math.max(0, readFreezeNumberEnv('ORCA_FREEZE_PRE_FLOOD_MS', 3000))
const scratchDir = process.env.ORCA_FREEZE_SCRATCH || ''

const { orcaJsonSync, orcaJsonAsync } = createOrcaRpc({ envName })

async function mapPool(items, concurrency, worker) {
  const results = Array.from({ length: items.length })
  let next = 0
  async function run() {
    while (next < items.length) {
      const index = next
      next += 1
      results[index] = await worker(items[index], index)
    }
  }
  const runners = Array.from({ length: Math.min(concurrency, items.length) }, () => run())
  await Promise.all(runners)
  return results
}

function sampleOrcaIfPossible() {
  if (process.platform !== 'darwin') {
    return null
  }
  try {
    const status = orcaJsonSync(['status'], { local: true }).result
    const pid = status?.app?.pid
    if (!pid) {
      return null
    }
    const out = path.join(reportDir, `orca-sample-${Date.now()}.txt`)
    const sampled = spawnSync('sample', [String(pid), '5', '-file', out], {
      timeout: 20_000,
      stdio: 'ignore'
    })
    return sampled.status === 0 ? out : null
  } catch {
    return null
  }
}

function floodCommand(marker) {
  // Continuous 2KB frames @ ~8ms — agent-like remote output.
  const script =
    "const m=process.argv[1];process.stdout.write('READY:'+m+'\\n');let f=0;const c='A'.repeat(2048);setInterval(()=>{f++;process.stdout.write('BG:'+m+':'+f+':'+c+'\\n')},8);process.stdin.resume()"
  return `node -e ${JSON.stringify(script)} ${JSON.stringify(marker)}`
}

async function main() {
  mkdirSync(reportDir, { recursive: true })
  const notes = []
  const timings = new BoundedLiveFreezeHistory(120)
  const amplificationSteps = []

  console.log(
    `[live-freeze] env=${envName} create=${createCount} passes=${switchPasses} parallel=${parallel}`
  )

  const status = orcaJsonSync(['status'])
  notes.push(
    `remote version=${status.result?.runtime?.appVersion} state=${status.result?.runtime?.state}`
  )
  const local = orcaJsonSync(['status'], { local: true })
  notes.push(`local version=${local.result?.runtime?.appVersion} pid=${local.result?.app?.pid}`)

  const worktrees = orcaJsonSync(['worktree', 'list']).result
  const wtList = worktrees?.worktrees || worktrees?.items || worktrees || []
  if (!Array.isArray(wtList) || wtList.length === 0) {
    throw new Error(`No worktrees on environment ${envName}`)
  }
  notes.push(`remote worktrees=${wtList.length}`)
  amplificationSteps.push(`baseline worktrees=${wtList.length}`)

  const targets = wtList.slice(0, Math.min(createWorktreeSpan, wtList.length))
  const created = []

  // Parallel flood-terminal creates across many worktrees.
  if (createCount > 0) {
    amplificationSteps.push(`create=${createCount} parallel=${Math.min(parallel, createCount)}`)
    const createJobs = Array.from({ length: createCount }, (_, i) => i)
    await mapPool(createJobs, Math.min(parallel, createCount), async (i) => {
      const wt = targets[i % targets.length]
      const selector = worktreeSelector(wt)
      if (!selector) {
        notes.push(`create ${i} skipped: no selector`)
        return
      }
      const marker = `LIVE_BULK_${Date.now()}_${i}`
      try {
        const createdTerm = await orcaJsonAsync(
          [
            'terminal',
            'create',
            '--worktree',
            selector,
            '--title',
            `freeze-repro-${i}`,
            '--command',
            floodCommand(marker)
          ],
          { timeoutMs: 180_000 }
        )
        timings.add({ op: 'terminal.create', ms: createdTerm.elapsedMs, ok: true, index: i })
        const handle = extractTerminalHandle(createdTerm.result)
        if (handle) {
          created.push({ handle, marker, worktree: selector })
          console.log(
            `[live-freeze] created ${handle} on ${selector} in ${createdTerm.elapsedMs.toFixed(0)}ms`
          )
        } else {
          notes.push(
            `create ${i} missing handle: ${JSON.stringify(createdTerm.result).slice(0, 400)}`
          )
        }
      } catch (error) {
        timings.add({ op: 'terminal.create', ms: null, ok: false, error: String(error), index: i })
        notes.push(`create ${i} failed: ${String(error).slice(0, 300)}`)
        console.warn(`[live-freeze] create failed: ${String(error)}`)
      }
    })
  }

  if (preFloodMs > 0 && created.length > 0) {
    amplificationSteps.push(`preFloodMs=${preFloodMs}`)
    await new Promise((r) => setTimeout(r, preFloodMs))
  }

  let live = []
  try {
    const listed = orcaJsonSync(['terminal', 'list'])
    const terms = listed.result?.terminals || []
    live = terms
      .filter(
        (t) => typeof t.handle === 'string' && t.handle.startsWith('term_') && t.connected !== false
      )
      .map((t) => ({ handle: t.handle, title: t.title, worktreeId: t.worktreeId }))
    notes.push(`live terminals listed=${live.length}`)
  } catch (error) {
    notes.push(`terminal list failed: ${String(error).slice(0, 200)}`)
  }

  let switchTargets = [...created.map((c) => c.handle), ...live.map((t) => t.handle)].filter(
    (v, i, a) => typeof v === 'string' && a.indexOf(v) === i
  )

  if (shouldCapSwitchTargets(maxSwitchTargets) && switchTargets.length > maxSwitchTargets) {
    switchTargets = applySwitchTargetCap(switchTargets, maxSwitchTargets)
    amplificationSteps.push(`capped switchTargets=${maxSwitchTargets}`)
  }

  if (switchTargets.length < 2) {
    throw new Error(
      `Need ≥2 terminals to bulk-switch; got ${switchTargets.length}. notes=${notes.join('; ')}`
    )
  }

  amplificationSteps.push(
    `switchTargets=${switchTargets.length} passes=${switchPasses} parallel=${parallel}`
  )
  console.log(
    `[live-freeze] bulk-switching ${switchTargets.length} terminals × ${switchPasses} passes (parallel=${parallel})`
  )

  let maxSwitchMs = 0
  let maxBatchWallMs = 0
  let sumSwitchMs = 0
  let switchCount = 0
  const switchStarted = performance.now()

  for (let pass = 0; pass < switchPasses; pass += 1) {
    // Chunk targets into concurrent batches — piles load onto client/UI path.
    for (let offset = 0; offset < switchTargets.length; offset += parallel) {
      const batch = switchTargets.slice(offset, offset + parallel)
      const batchStarted = performance.now()
      const batchResults = await Promise.all(
        batch.map(async (handle) => {
          try {
            const sw = await orcaJsonAsync(['terminal', 'switch', '--terminal', handle], {
              timeoutMs: 90_000
            })
            return { handle, ms: sw.elapsedMs, ok: true }
          } catch (error) {
            return { handle, error: String(error), ok: false }
          }
        })
      )
      const batchWall = performance.now() - batchStarted
      maxBatchWallMs = Math.max(maxBatchWallMs, batchWall)
      for (const item of batchResults) {
        if (item.ok) {
          maxSwitchMs = Math.max(maxSwitchMs, item.ms)
          sumSwitchMs += item.ms
          switchCount += 1
          timings.add({ op: 'terminal.switch', handle: item.handle, ms: item.ms, batchWall })
          if (item.ms >= softMs) {
            console.warn(`[live-freeze] SOFT lag on switch ${item.handle}: ${item.ms.toFixed(0)}ms`)
          }
          if (item.ms >= hardMs) {
            console.warn(`[live-freeze] HARD lag on switch ${item.handle}: ${item.ms.toFixed(0)}ms`)
          }
        } else {
          timings.add({ op: 'terminal.switch', handle: item.handle, error: item.error })
          notes.push(`switch ${item.handle} failed: ${String(item.error).slice(0, 200)}`)
        }
      }
      if (batchWall >= softMs) {
        console.warn(`[live-freeze] SOFT batch wall=${batchWall.toFixed(0)}ms size=${batch.length}`)
      }
      if (batchWall >= hardMs) {
        console.warn(`[live-freeze] HARD batch wall=${batchWall.toFixed(0)}ms size=${batch.length}`)
      }
    }
  }

  const bulkWallMs = performance.now() - switchStarted
  const avgSwitchMs = switchCount ? sumSwitchMs / switchCount : 0

  const statusProbe = orcaJsonSync(['status'], { local: true })
  let memoryProbeMs = null
  try {
    const mem = orcaJsonSync(['diagnostics', 'memory'], { local: true, timeoutMs: 120_000 })
    memoryProbeMs = mem.elapsedMs
    notes.push(`memory diagnostic ms=${mem.elapsedMs.toFixed(0)}`)
  } catch (error) {
    notes.push(`memory diagnostic failed: ${String(error).slice(0, 200)}`)
  }

  const { peakLatencyMs, softFreeze, hardFreeze } = evaluateFreezeSignals({
    maxSwitchMs,
    maxBatchWallMs,
    statusProbeMs: statusProbe.elapsedMs,
    memoryProbeMs,
    softMs,
    hardMs
  })

  let samplePath = null
  if (softFreeze || hardFreeze) {
    samplePath = sampleOrcaIfPossible()
    if (samplePath) {
      notes.push(`sample=${samplePath}`)
    } else {
      notes.push('sample unavailable')
    }
  }

  const report = {
    topology: 'live-paired-remote',
    environment: envName,
    localVersion: local.result?.runtime?.appVersion,
    remoteVersion: status.result?.runtime?.appVersion,
    remoteWorktreeCount: wtList.length,
    createdTerminals: created.length,
    switchTargets: switchTargets.length,
    switchPasses,
    parallel,
    maxSwitchMs,
    maxBatchWallMs,
    peakLatencyMs,
    avgSwitchMs,
    bulkWallMs,
    statusProbeMs: statusProbe.elapsedMs,
    memoryProbeMs,
    softFreeze,
    hardFreeze,
    softMs,
    hardMs,
    amplificationSteps,
    notes,
    timingCount: timings.totalCount,
    timings: timings.values()
  }

  const outPath = path.join(reportDir, `live-bulk-open-freeze-${envName}.json`)
  writeFileSync(outPath, `${JSON.stringify(report, null, 2)}\n`)
  // Also write a stamped peak report so amplification runs don't overwrite history.
  const stamped = path.join(reportDir, `live-bulk-open-freeze-${envName}-peak-${Date.now()}.json`)
  writeFileSync(stamped, `${JSON.stringify(report, null, 2)}\n`)
  console.log(`[live-freeze] report ${outPath}`)
  console.log(`[live-freeze] stamped ${stamped}`)
  console.log(JSON.stringify(report, null, 2))

  if (scratchDir) {
    try {
      mkdirSync(scratchDir, { recursive: true })
      copyFileSync(outPath, path.join(scratchDir, 'live-bulk-open-freeze-report.json'))
      writeFileSync(
        path.join(scratchDir, 'live-freeze-amplify-summary.json'),
        `${JSON.stringify(
          {
            peakLatencyMs,
            hardFreeze,
            softFreeze,
            amplificationSteps,
            stamped
          },
          null,
          2
        )}\n`
      )
    } catch (error) {
      notes.push(`scratch copy failed: ${String(error).slice(0, 200)}`)
    }
  }

  if (hardFreeze) {
    process.exitCode = 2
    console.error('[live-freeze] HARD FREEZE SIGNAL')
  } else if (softFreeze) {
    process.exitCode = 1
    console.error('[live-freeze] SOFT FREEZE SIGNAL')
  } else {
    console.log('[live-freeze] no freeze signal under thresholds')
  }
}

main().catch((error) => {
  console.error('[live-freeze] failed', error)
  process.exit(3)
})
