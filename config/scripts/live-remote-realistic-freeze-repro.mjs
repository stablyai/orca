#!/usr/bin/env node
/**
 * Naturalistic freeze repro — idle/reconnect recovery stories on large remotes.
 *
 * Unlike the bulk parallel-switch amplifier, this models:
 *   1) agents streaming on remote while user is idle (backlog builds)
 *   2) user returns and opens sessions one-by-one (or after reconnect refresh)
 *
 * Scenarios:
 *   idle-backlog-open            — idle with flood, then human-paced sequential open
 *   idle-backlog-reconnect-open  — same + wake-like metadata refresh storm, then open
 *   restart-proxy                — idle, then orca open + status/list storm + open
 *                                  (does NOT kill the desktop; proxies restore work)
 *
 * Usage:
 *   ORCA_FREEZE_ENV=paired-remote ORCA_FREEZE_SCENARIO=idle-backlog-open \
 *     node config/scripts/live-remote-realistic-freeze-repro.mjs
 *
 *   pnpm run repro:live-remote-realistic-freeze
 */
import { spawnSync } from 'node:child_process'
import { copyFileSync, mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { createOrcaRpc } from './live-remote-freeze-rpc.mjs'
import { startStatusWatchdog } from './live-remote-status-watchdog.mjs'
import { BoundedLiveFreezeHistory } from './live-freeze-bounded-history.mjs'
import {
  DEFAULT_FOREVER_WINDOW_MS,
  DEFAULT_HARD_MS,
  DEFAULT_SOFT_MS,
  DEFAULT_STATUS_SLOW_MS,
  evaluateFullAppFreeze,
  evaluatePermanentLockup,
  evaluateRealisticFreezeSignals,
  extractTerminalHandle,
  humanPaceDelayMs,
  readFreezeNumberEnv,
  REALISTIC_SCENARIOS,
  worktreeSelector
} from './live-remote-bulk-open-freeze-metrics.mjs'

const root = path.resolve(import.meta.dirname, '../..')
const reportDir = path.join(root, 'test-results', 'freeze-repro')
const envName = process.env.ORCA_FREEZE_ENV || 'paired-remote'
const scenario = process.env.ORCA_FREEZE_SCENARIO || 'idle-backlog-open'
const createCount = Math.max(0, readFreezeNumberEnv('ORCA_FREEZE_CREATE', 0))
const openCount = Math.max(2, readFreezeNumberEnv('ORCA_FREEZE_OPEN_COUNT', 20))
const idleMs = Math.max(0, readFreezeNumberEnv('ORCA_FREEZE_IDLE_MS', 45_000))
const paceMs = Math.max(0, readFreezeNumberEnv('ORCA_FREEZE_PACE_MS', 250))
const paceJitterMs = Math.max(0, readFreezeNumberEnv('ORCA_FREEZE_PACE_JITTER_MS', 150))
const createWorktreeSpan = Math.max(1, readFreezeNumberEnv('ORCA_FREEZE_CREATE_WT_SPAN', 12))
const softMs = readFreezeNumberEnv('ORCA_FREEZE_SOFT_MS', DEFAULT_SOFT_MS)
const hardMs = readFreezeNumberEnv('ORCA_FREEZE_HARD_MS', DEFAULT_HARD_MS)
/** Concurrent opens during lockup-storm (wake refresh overlaps fan-out). */
const stormParallel = Math.max(1, readFreezeNumberEnv('ORCA_FREEZE_STORM_PARALLEL', 16))
/** Kill a switch if it exceeds this — counts toward permanent lockup. */
const opTimeoutMs = Math.max(10_000, readFreezeNumberEnv('ORCA_FREEZE_OP_TIMEOUT_MS', 60_000))
const permanentTimeoutMs = Math.max(15_000, readFreezeNumberEnv('ORCA_FREEZE_PERMANENT_MS', 60_000))
const foreverWindowMs = Math.max(
  10_000,
  readFreezeNumberEnv('ORCA_FREEZE_FOREVER_WINDOW_MS', DEFAULT_FOREVER_WINDOW_MS)
)
const statusSlowMs = Math.max(
  5_000,
  readFreezeNumberEnv('ORCA_FREEZE_STATUS_SLOW_MS', DEFAULT_STATUS_SLOW_MS)
)
const watchdogIntervalMs = Math.max(
  500,
  readFreezeNumberEnv('ORCA_FREEZE_WATCHDOG_INTERVAL_MS', 1500)
)
const scratchDir = process.env.ORCA_FREEZE_SCRATCH || ''

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

const rpc = createOrcaRpc({ envName })
const { orcaJsonSync, orcaJsonAsync, runReconnectRefreshStorm, runRestartProxy } = rpc

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
  await Promise.all(
    Array.from({ length: Math.min(concurrency, Math.max(items.length, 1)) }, () => run())
  )
  return results
}

function floodCommand(marker) {
  const script =
    "const m=process.argv[1];process.stdout.write('READY:'+m+'\n');let f=0;const c='A'.repeat(2048);setInterval(()=>{f++;process.stdout.write('BG:'+m+':'+f+':'+c+'\n')},8);process.stdin.resume()"
  return `node -e ${JSON.stringify(script)} ${JSON.stringify(marker)}`
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
    const out = path.join(reportDir, `orca-sample-realistic-${Date.now()}.txt`)
    const sampled = spawnSync('sample', [String(pid), '5', '-file', out], {
      timeout: 20_000,
      stdio: 'ignore'
    })
    return sampled.status === 0 ? out : null
  } catch {
    return null
  }
}

function listLiveTerminalHandles() {
  const listed = orcaJsonSync(['terminal', 'list'])
  const terms = listed.result?.terminals || []
  return terms
    .filter((t) => typeof t.handle === 'string' && t.handle.startsWith('term_'))
    .map((t) => ({
      handle: t.handle,
      title: t.title,
      worktreeId: t.worktreeId,
      connected: t.connected
    }))
}

async function main() {
  if (!REALISTIC_SCENARIOS.includes(scenario)) {
    throw new Error(
      `Unknown ORCA_FREEZE_SCENARIO=${scenario}. Expected one of: ${REALISTIC_SCENARIOS.join(', ')}`
    )
  }

  mkdirSync(reportDir, { recursive: true })
  const notes = []
  const phases = []
  const openTimings = new BoundedLiveFreezeHistory(100)

  console.log(
    `[realistic-freeze] scenario=${scenario} env=${envName} create=${createCount} idleMs=${idleMs} openCount=${openCount} paceMs=${paceMs}`
  )

  const local = orcaJsonSync(['status'], { local: true })
  const remote = orcaJsonSync(['status'])
  notes.push(
    `local version=${local.result?.runtime?.appVersion} pid=${local.result?.app?.pid}`,
    `remote version=${remote.result?.runtime?.appVersion} state=${remote.result?.runtime?.state}`
  )

  const worktrees = orcaJsonSync(['worktree', 'list']).result
  const wtList = worktrees?.worktrees || worktrees?.items || worktrees || []
  if (!Array.isArray(wtList) || wtList.length === 0) {
    throw new Error(`No worktrees on environment ${envName}`)
  }
  notes.push(`remote worktrees=${wtList.length}`)
  phases.push({ phase: 'baseline', worktrees: wtList.length })

  // --- Phase: seed flood terminals (agent-like backlog sources) ---
  const created = []
  if (createCount > 0) {
    const targets = wtList.slice(0, Math.min(createWorktreeSpan, wtList.length))
    await mapPool(
      Array.from({ length: createCount }, (_, i) => i),
      Math.min(4, createCount),
      async (i) => {
        const wt = targets[i % targets.length]
        const selector = worktreeSelector(wt)
        if (!selector) {
          return
        }
        const marker = `REALISTIC_${Date.now()}_${i}`
        try {
          const createdTerm = await orcaJsonAsync(
            [
              'terminal',
              'create',
              '--worktree',
              selector,
              '--title',
              `realistic-freeze-${i}`,
              '--command',
              floodCommand(marker)
            ],
            { timeoutMs: 180_000 }
          )
          const handle = extractTerminalHandle(createdTerm.result)
          if (handle) {
            created.push({ handle, marker, worktree: selector })
            console.log(
              `[realistic-freeze] flood terminal ${handle} (${createdTerm.elapsedMs.toFixed(0)}ms)`
            )
          } else {
            notes.push(
              `create ${i} missing handle: ${JSON.stringify(createdTerm.result).slice(0, 300)}`
            )
          }
        } catch (error) {
          notes.push(`create ${i} failed: ${String(error).slice(0, 250)}`)
          console.warn(`[realistic-freeze] create failed: ${String(error)}`)
        }
      }
    )
    phases.push({ phase: 'seed-flood', created: created.length })
  }

  // Prefer created floods for open pass; fill with existing live terminals.
  let live = []
  try {
    live = listLiveTerminalHandles()
    notes.push(`live terminals listed=${live.length}`)
  } catch (error) {
    notes.push(`terminal list failed: ${String(error).slice(0, 200)}`)
  }

  const openTargets = [...created.map((c) => c.handle), ...live.map((t) => t.handle)].filter(
    (v, i, a) => typeof v === 'string' && a.indexOf(v) === i
  )

  if (openTargets.length < 2) {
    throw new Error(`Need ≥2 terminals; got ${openTargets.length}. ${notes.join('; ')}`)
  }

  const openList = openTargets.slice(0, Math.min(openCount, openTargets.length))

  // --- Phase: park — leave one session focused, rest accumulate flood while "away" ---
  try {
    const parkHandle = openList[0]
    const parked = await orcaJsonAsync(['terminal', 'switch', '--terminal', parkHandle], {
      timeoutMs: 60_000
    })
    notes.push(`park switch ms=${parked.elapsedMs.toFixed(0)} handle=${parkHandle}`)
  } catch (error) {
    notes.push(`park switch failed: ${String(error).slice(0, 200)}`)
  }

  console.log(`[realistic-freeze] idle ${idleMs}ms while remotes stream (user away / asleep)`)
  const idleStarted = performance.now()
  await sleep(idleMs)
  phases.push({ phase: 'idle', idleMs, actualMs: performance.now() - idleStarted })

  // --- Phase: recovery trigger ---
  let reconnectRefreshMs = 0
  let timedOutOps = 0
  let consecutiveSwitchFailures = 0
  let maxConsecutiveSwitchFailures = 0

  if (scenario === 'idle-backlog-reconnect-open' || scenario === 'lockup-storm') {
    console.log(
      '[realistic-freeze] wake/reconnect proxy: parallel status/worktree/terminal refresh'
    )
    const storm = await runReconnectRefreshStorm(notes)
    reconnectRefreshMs = Math.max(storm.wallMs, storm.maxJobMs)
    phases.push({
      phase: 'reconnect-refresh',
      wallMs: storm.wallMs,
      maxJobMs: storm.maxJobMs
    })
  } else if (scenario === 'restart-proxy') {
    console.log('[realistic-freeze] restart proxy: orca open + refresh storm (no process kill)')
    const restart = await runRestartProxy(notes)
    reconnectRefreshMs = Math.max(restart.wallMs, restart.storm.wallMs, restart.storm.maxJobMs)
    phases.push({
      phase: 'restart-proxy',
      wallMs: restart.wallMs,
      reconnectWallMs: restart.storm.wallMs
    })
  }

  // --- Phase: open sessions ---
  // lockup-storm: overlap a second reconnect storm with concurrent switch fan-out
  // (models wake + bulk session restore, not human serial clicks).
  let maxOpenMs = 0
  let firstOpenMs = 0
  let sumOpenMs = 0
  let openOk = 0
  let maxBatchWallMs = 0
  const openStarted = performance.now()

  let statusWatch = null
  if (scenario === 'lockup-storm') {
    console.log(
      `[realistic-freeze] LOCKUP STORM: concurrent open parallel=${stormParallel} + overlapping reconnect refresh (timeout=${opTimeoutMs}ms); mid-storm status watchdog every ${watchdogIntervalMs}ms`
    )
    statusWatch = startStatusWatchdog({
      intervalMs: watchdogIntervalMs,
      timeoutMs: Math.min(permanentTimeoutMs, foreverWindowMs),
      statusSlowMs
    })
    // Fire reconnect storm again concurrently with first open wave.
    const overlapStormPromise = runReconnectRefreshStorm(notes)
    for (let offset = 0; offset < openList.length; offset += stormParallel) {
      const batch = openList.slice(offset, offset + stormParallel)
      const batchStarted = performance.now()
      const batchResults = await Promise.all(
        batch.map(async (handle, batchIndex) => {
          const index = offset + batchIndex
          try {
            const sw = await orcaJsonAsync(['terminal', 'switch', '--terminal', handle], {
              timeoutMs: opTimeoutMs
            })
            return { handle, index, ms: sw.elapsedMs, ok: true, timedOut: false }
          } catch (error) {
            const msg = String(error)
            const timedOut = /timed out/i.test(msg)
            return { handle, index, error: msg, ok: false, timedOut }
          }
        })
      )
      const batchWall = performance.now() - batchStarted
      maxBatchWallMs = Math.max(maxBatchWallMs, batchWall)
      for (const item of batchResults) {
        if (item.ok) {
          openOk += 1
          sumOpenMs += item.ms
          maxOpenMs = Math.max(maxOpenMs, item.ms)
          if (item.index === 0 || firstOpenMs === 0) {
            firstOpenMs = item.ms
          }
          consecutiveSwitchFailures = 0
          openTimings.add({
            handle: item.handle,
            ms: item.ms,
            index: item.index,
            batchWall
          })
          if (item.ms >= hardMs) {
            console.warn(
              `[realistic-freeze] HARD open #${item.index} ${item.handle}: ${item.ms.toFixed(0)}ms`
            )
          }
        } else {
          if (item.timedOut) {
            timedOutOps += 1
          }
          consecutiveSwitchFailures += 1
          maxConsecutiveSwitchFailures = Math.max(
            maxConsecutiveSwitchFailures,
            consecutiveSwitchFailures
          )
          openTimings.add({
            handle: item.handle,
            error: item.error,
            index: item.index,
            timedOut: item.timedOut
          })
          notes.push(
            `open ${item.handle} failed${item.timedOut ? ' (TIMEOUT)' : ''}: ${String(item.error).slice(0, 160)}`
          )
          console.warn(
            `[realistic-freeze] open FAIL #${item.index}${item.timedOut ? ' TIMEOUT' : ''}: ${item.handle}`
          )
        }
      }
      if (batchWall >= hardMs) {
        console.warn(
          `[realistic-freeze] HARD batch wall=${batchWall.toFixed(0)}ms size=${batch.length}`
        )
      }
    }
    try {
      const overlap = await overlapStormPromise
      reconnectRefreshMs = Math.max(reconnectRefreshMs, overlap.wallMs, overlap.maxJobMs)
      phases.push({
        phase: 'overlap-reconnect-refresh',
        wallMs: overlap.wallMs,
        maxJobMs: overlap.maxJobMs
      })
    } catch (error) {
      notes.push(`overlap reconnect failed: ${String(error).slice(0, 200)}`)
    }
    phases.push({
      phase: 'lockup-storm-open',
      count: openList.length,
      ok: openOk,
      maxOpenMs,
      firstOpenMs,
      maxBatchWallMs,
      timedOutOps,
      parallel: stormParallel
    })
  } else {
    console.log(
      `[realistic-freeze] human-paced open of ${openList.length} sessions (pace≈${paceMs}ms + jitter)`
    )
    for (let i = 0; i < openList.length; i += 1) {
      const handle = openList[i]
      try {
        const sw = await orcaJsonAsync(['terminal', 'switch', '--terminal', handle], {
          timeoutMs: opTimeoutMs
        })
        openOk += 1
        sumOpenMs += sw.elapsedMs
        maxOpenMs = Math.max(maxOpenMs, sw.elapsedMs)
        if (i === 0) {
          firstOpenMs = sw.elapsedMs
        }
        consecutiveSwitchFailures = 0
        openTimings.add({ handle, ms: sw.elapsedMs, index: i })
        if (sw.elapsedMs >= softMs) {
          console.warn(`[realistic-freeze] SOFT open #${i} ${handle}: ${sw.elapsedMs.toFixed(0)}ms`)
        }
        if (sw.elapsedMs >= hardMs) {
          console.warn(`[realistic-freeze] HARD open #${i} ${handle}: ${sw.elapsedMs.toFixed(0)}ms`)
        }
      } catch (error) {
        const msg = String(error)
        const timedOut = /timed out/i.test(msg)
        if (timedOut) {
          timedOutOps += 1
        }
        consecutiveSwitchFailures += 1
        maxConsecutiveSwitchFailures = Math.max(
          maxConsecutiveSwitchFailures,
          consecutiveSwitchFailures
        )
        openTimings.add({ handle, error: msg, index: i, timedOut })
        notes.push(`open ${handle} failed${timedOut ? ' (TIMEOUT)' : ''}: ${msg.slice(0, 200)}`)
      }
      if (i < openList.length - 1) {
        await sleep(humanPaceDelayMs(paceMs, paceJitterMs))
      }
    }
    phases.push({
      phase: 'human-paced-open',
      count: openList.length,
      ok: openOk,
      maxOpenMs,
      firstOpenMs,
      openWallMs: performance.now() - openStarted
    })
  }

  const openWallMs = performance.now() - openStarted

  let midStormWatch = {
    samples: [],
    durationMs: 0,
    sampleCount: 0,
    maxStatusMs: 0,
    unhealthySampleCount: 0,
    infrastructureErrorCount: 0,
    longestUnhealthyWindowMs: 0
  }
  if (statusWatch) {
    midStormWatch = await statusWatch.stop()
    notes.push(
      `mid-storm status samples=${midStormWatch.sampleCount} durationMs=${midStormWatch.durationMs.toFixed(0)}`
    )
    phases.push({
      phase: 'mid-storm-status-watchdog',
      samples: midStormWatch.sampleCount,
      durationMs: midStormWatch.durationMs,
      maxStatusMs: midStormWatch.maxStatusMs
    })
  }

  // Post-storm health: does local status still answer?
  let statusProbeMs = null
  let statusHangMs = 0
  const statusStarted = performance.now()
  try {
    const statusProbe = await orcaJsonAsync(['status'], {
      local: true,
      timeoutMs: permanentTimeoutMs
    })
    statusProbeMs = statusProbe.elapsedMs
  } catch (error) {
    statusHangMs = performance.now() - statusStarted
    notes.push(
      `status probe FAILED after ${statusHangMs.toFixed(0)}ms: ${String(error).slice(0, 200)}`
    )
    console.error(`[realistic-freeze] status probe failed — possible permanent lockup`)
  }

  let memoryProbeMs = null
  try {
    const mem = await orcaJsonAsync(['diagnostics', 'memory'], {
      local: true,
      timeoutMs: permanentTimeoutMs
    })
    memoryProbeMs = mem.elapsedMs
    notes.push(`memory diagnostic ms=${mem.elapsedMs.toFixed(0)}`)
  } catch (error) {
    notes.push(`memory diagnostic failed: ${String(error).slice(0, 200)}`)
  }

  const peakForSignals = Math.max(maxOpenMs, firstOpenMs, maxBatchWallMs)
  const signals = evaluateRealisticFreezeSignals({
    maxOpenMs: peakForSignals,
    firstOpenMs,
    reconnectRefreshMs,
    statusProbeMs: statusProbeMs ?? 0,
    memoryProbeMs,
    softMs,
    hardMs
  })

  const lockup = evaluatePermanentLockup({
    timedOutOps,
    statusHangMs,
    consecutiveSwitchFailures: maxConsecutiveSwitchFailures,
    openFailed: openList.length - openOk,
    openTotal: openList.length,
    permanentTimeoutMs
  })

  const fullApp = evaluateFullAppFreeze({
    statusSamples: midStormWatch.samples,
    statusSummary: midStormWatch,
    foreverWindowMs,
    statusSlowMs
  })
  const watchdogInfrastructureErrorCount = midStormWatch.infrastructureErrorCount
  if (statusHangMs >= foreverWindowMs) {
    fullApp.foreverUiLockupObserved = true
    fullApp.longestUnhealthyWindowMs = Math.max(fullApp.longestUnhealthyWindowMs, statusHangMs)
    fullApp.reason = `post-storm status hang ${statusHangMs.toFixed(0)}ms`
  }

  const recoveredHardStall = signals.hardFreeze && !fullApp.foreverUiLockupObserved && openOk > 0

  let samplePath = null
  if (signals.softFreeze || signals.hardFreeze || fullApp.foreverUiLockupObserved) {
    samplePath = sampleOrcaIfPossible()
    if (samplePath) {
      notes.push(`sample=${samplePath}`)
    } else {
      notes.push('sample unavailable')
    }
  }

  const storyByScenario = {
    'idle-backlog-open': 'User away while remotes stream; returns and opens sessions one-by-one.',
    'idle-backlog-reconnect-open':
      'User away; wake-like reconnect metadata storm; then opens sessions.',
    'restart-proxy': 'User away; restart-proxy discovery; then opens sessions.',
    'lockup-storm':
      'Idle flood + reconnect refresh + concurrent open + mid-storm status watchdog (full-app freeze bar).'
  }

  const report = {
    topology: 'live-paired-remote-realistic',
    scenario,
    story: storyByScenario[scenario] || scenario,
    environment: envName,
    localVersion: local.result?.runtime?.appVersion,
    remoteVersion: remote.result?.runtime?.appVersion,
    remoteWorktreeCount: wtList.length,
    createdFloodTerminals: created.length,
    openTargets: openList.length,
    idleMs,
    paceMs,
    paceJitterMs,
    stormParallel: scenario === 'lockup-storm' ? stormParallel : 1,
    firstOpenMs,
    maxOpenMs,
    maxBatchWallMs,
    avgOpenMs: openOk ? sumOpenMs / openOk : 0,
    openWallMs,
    openOk,
    openFailed: openList.length - openOk,
    reconnectRefreshMs,
    peakLatencyMs: Math.max(signals.peakLatencyMs, maxBatchWallMs),
    statusProbeMs,
    statusHangMs,
    memoryProbeMs,
    softFreeze: signals.softFreeze,
    hardFreeze: signals.hardFreeze,
    recoveredHardStall,
    permanentLockup: lockup.permanentLockup,
    foreverUiLockupObserved: fullApp.foreverUiLockupObserved,
    foreverFreeze: fullApp,
    midStormStatusSamples: midStormWatch.samples,
    midStormStatusSampleCount: midStormWatch.sampleCount,
    watchdogInfrastructureErrorCount,
    timedOutOps,
    maxConsecutiveSwitchFailures,
    softMs,
    hardMs,
    foreverWindowMs,
    statusSlowMs,
    permanentTimeoutMs,
    opTimeoutMs,
    phases,
    notes,
    openTimingCount: openTimings.totalCount,
    openTimings: openTimings.values()
  }

  const outPath = path.join(reportDir, `live-realistic-freeze-${envName}-${scenario}.json`)
  const stamped = path.join(
    reportDir,
    `live-realistic-freeze-${envName}-${scenario}-peak-${Date.now()}.json`
  )
  writeFileSync(outPath, `${JSON.stringify(report, null, 2)}\n`)
  writeFileSync(stamped, `${JSON.stringify(report, null, 2)}\n`)
  console.log(`[realistic-freeze] report ${outPath}`)
  console.log(JSON.stringify(report, null, 2))

  if (scratchDir) {
    try {
      mkdirSync(scratchDir, { recursive: true })
      copyFileSync(outPath, path.join(scratchDir, 'live-realistic-freeze-report.json'))
    } catch (error) {
      console.warn(`[realistic-freeze] scratch copy failed: ${String(error)}`)
    }
  }

  if (watchdogInfrastructureErrorCount > 0) {
    process.exitCode = 3
    console.error('[realistic-freeze] WATCHDOG INFRASTRUCTURE FAILURE')
  } else if (fullApp.foreverUiLockupObserved) {
    process.exitCode = 5
    console.error('[realistic-freeze] FULL-APP FOREVER FREEZE (status unhealthy ≥ forever window)')
  } else if (lockup.permanentLockup) {
    process.exitCode = 4
    console.error(
      '[realistic-freeze] PERMANENT LOCKUP HEURISTIC (timeouts/fail-rate) — check foreverUiLockupObserved'
    )
  } else if (signals.hardFreeze) {
    process.exitCode = 2
    console.error(
      '[realistic-freeze] HARD FREEZE SIGNAL (recovered multi-second stall — not forever lockup)'
    )
  } else if (signals.softFreeze) {
    process.exitCode = 1
    console.error('[realistic-freeze] SOFT FREEZE SIGNAL')
  } else {
    console.log('[realistic-freeze] no freeze signal under thresholds')
  }
}

main().catch((error) => {
  console.error('[realistic-freeze] failed', error)
  process.exit(3)
})
