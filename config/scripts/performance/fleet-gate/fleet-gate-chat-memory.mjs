// Idle-chat memory slope: main's memory growth per live idle chat, judged on NEW alone.
import fs from 'node:fs'
import path from 'node:path'
import { copyProfile } from './fleet-gate-copies.mjs'
import {
  createChatBurst,
  pointClaudeAtStub,
  waitForLaunches,
  writeClaudeStub
} from './fleet-gate-launch-burst.mjs'
import { removeRunDir } from './fleet-gate-run-dirs.mjs'
import { closeStartupDialogs } from './fleet-gate-scenarios.mjs'
import { readFleetCensus, SEED_SHAPE } from './fleet-gate-synthetic-seed.mjs'

const CHAT_MEMORY_LOW = 10
const CHAT_MEMORY_HIGH = 200
// Main today reads 0.27-0.40 MB per live idle chat on the seed; a build keeping 1 MB more per chat reads ~1.3.
const MAX_MAIN_MB_PER_CHAT = 0.75
const RELEASE_WAIT_MS = 60_000
const SAMPLE_WINDOW_MS = 60_000
const SAMPLE_EVERY_MS = 5_000
// Memory falling this much as 190 chats start means a reading was wrong, not that chats are free.
const MIN_MAIN_MB_PER_CHAT = -0.25

const STATUS_SETTLE_MS = 2_000
const IDLE_WAIT_MS = 300_000
const IDLE_POLL_MS = 10_000

/** Of these chats, how many the host reports idle after a successful turn with their provider running. */
async function idleLiveChatCount(page, sessionIds) {
  return page.evaluate(
    ({ ids, settleMs }) =>
      new Promise((resolve, reject) => {
        const wanted = new Set(ids)
        // The host sends a naming-only snapshot (no sessions) before the status one, so merge frames briefly.
        const rows = new Map()
        let subscription = null
        let settled = false
        let quiet = null
        const timer = setTimeout(() => stop(new Error('no status snapshot in 30 s')), 30_000)
        const stop = (error) => {
          settled = true
          clearTimeout(timer)
          clearTimeout(quiet)
          subscription?.unsubscribe()
          if (error) {
            reject(error)
            return
          }
          const seen = {}
          let done = 0
          for (const row of rows.values()) {
            const key = `${String(row.status)}/${String(row.turnOutcome)}/${row.hostExecutionPhase ?? 'no-child'}`
            seen[key] = (seen[key] ?? 0) + 1
            if (
              row.status === 'idle' &&
              row.turnOutcome === 'success' &&
              row.hostExecutionOwned === true &&
              row.hostExecutionPhase !== 'starting'
            ) {
              done += 1
            }
          }
          resolve({ done, seen })
        }
        window.api.runtime
          .subscribe({ method: 'agentSession.subscribeStatus', params: {} }, (response) => {
            if (settled) {
              return
            }
            if (!response.ok) {
              stop(new Error(`status stream: ${JSON.stringify(response.error).slice(0, 200)}`))
              return
            }
            const event = response.result
            const incoming =
              event?.type === 'snapshot'
                ? event.sessions
                : event?.type === 'status'
                  ? [event.session]
                  : []
            for (const row of incoming) {
              if (wanted.has(row.sessionId)) {
                rows.set(row.sessionId, row)
              }
            }
            if (event?.type === 'snapshot' && quiet === null) {
              quiet = setTimeout(() => stop(null), settleMs)
            }
          })
          .then((handle) => {
            subscription = handle
            if (settled) {
              handle.unsubscribe()
            }
          }, stop)
      }),
    { ids: sessionIds, settleMs: STATUS_SETTLE_MS }
  )
}

/** Chat stub processes still running: the reading only counts if every chat it started is alive. */
function liveChatCount(launchLog) {
  const lines = fs.existsSync(launchLog) ? fs.readFileSync(launchLog, 'utf8').split('\n') : []
  let live = 0
  for (const line of lines) {
    if (!line.includes('"--input-format"')) {
      continue
    }
    try {
      process.kill(JSON.parse(line).pid, 0)
      live += 1
    } catch {}
  }
  return live
}

/**
 * Main's private footprint once V8 has handed back the freed pages of the last chat burst (a memory-pressure
 * signal, then a minute), as the lowest of 12 samples. Without the signal those pages linger for minutes and
 * swamp the slope. Footprint, not RSS: it still counts pages a loaded QA machine swapped or compressed.
 */
async function sampleMainFootprintMb(electronApp, page) {
  const cdp = await page.context().newCDPSession(page)
  try {
    await cdp.send('Memory.simulatePressureNotification', { level: 'critical' })
  } finally {
    await cdp.detach().catch(() => {})
  }
  await new Promise((resolve) => setTimeout(resolve, RELEASE_WAIT_MS))
  let lowest = Infinity
  const deadline = Date.now() + SAMPLE_WINDOW_MS
  while (Date.now() < deadline) {
    const kb = await electronApp.evaluate(
      async () => (await process.getProcessMemoryInfo()).private
    )
    lowest = Math.min(lowest, kb / 1024)
    await new Promise((resolve) => setTimeout(resolve, SAMPLE_EVERY_MS))
  }
  return Math.round(lowest * 10) / 10
}

/** Main's footprint at 10 then 200 live idle chats on the full fleet, each read the same way once burst garbage is gone. */
export async function chatMemoryOnce({
  launchCopy,
  arm,
  sha,
  buildDir,
  seedDir,
  runDir,
  outDir,
  repoRoot,
  options
}) {
  const userDataDir = path.join(runDir, 'user-data')
  copyProfile(seedDir, userDataDir)
  const stub = writeClaudeStub(path.join(runDir, 'stub'), repoRoot)
  const label = `chat-mem-${arm}-${sha.slice(0, 11)}`
  const result = { arm, sha, incomplete: [] }
  const copy = await launchCopy({
    buildDir,
    runDir,
    userDataDir,
    label,
    outDir,
    extraEnv: { PATH: [path.dirname(stub.command), process.env.PATH ?? ''].join(path.delimiter) }
  })
  try {
    await pointClaudeAtStub(copy.page, stub.command)
    // A settle longer than the idle stop would read memory with the chats already stopped.
    await copy.page.evaluate(() =>
      window.__store.getState().updateSettings({ nativeChatIdleStopMinutes: 0 })
    )
    await new Promise((resolve) => setTimeout(resolve, options.settleMs))
    await closeStartupDialogs(copy.page, result.incomplete)
    const { workspaces } = await readFleetCensus(copy.page)
    const fleet = SEED_SHAPE.worktrees + SEED_SHAPE.folders
    if (!(workspaces >= fleet)) {
      result.incomplete.push(
        `chat-mem: fleet loaded ${String(workspaces)} of ${String(fleet)} workspaces`
      )
    }
    const sessionIds = []
    const step = async (count, offset) => {
      const batch = await createChatBurst(copy.page, count, offset, 'fleet gate idle turn')
      sessionIds.push(...batch.sessionIds)
      if (batch.requested !== count || batch.refused.length > 0) {
        result.incomplete.push(
          `chat-mem: ${String(batch.requested)} of ${String(count)} chats requested, ${String(batch.refused.length)} refused`
        )
        return null
      }
      const launched = await waitForLaunches(stub.launchLog, offset + count, 300_000)
      if (launched < offset + count) {
        result.incomplete.push(
          `chat-mem: ${String(launched)} of ${String(offset + count)} chats started`
        )
        return null
      }
      // Every first turn must be over before the settle, so none finishes inside the sampling window.
      const idleBy = Date.now() + IDLE_WAIT_MS
      let ready = await idleLiveChatCount(copy.page, sessionIds)
      while (ready.done < offset + count && Date.now() < idleBy) {
        await new Promise((resolve) => setTimeout(resolve, IDLE_POLL_MS))
        ready = await idleLiveChatCount(copy.page, sessionIds)
      }
      if (ready.done < offset + count) {
        result.incomplete.push(
          `chat-mem: ${String(ready.done)} of ${String(offset + count)} chats idle after a successful turn within ${String(IDLE_WAIT_MS / 1000)} s (${JSON.stringify(ready.seen)})`
        )
        return null
      }
      await new Promise((resolve) => setTimeout(resolve, options.chatSettleMs))
      const footprint = await sampleMainFootprintMb(copy.app, copy.page)
      const live = liveChatCount(stub.launchLog)
      const idle = await idleLiveChatCount(copy.page, sessionIds)
      if (live < offset + count || idle.done < offset + count) {
        result.incomplete.push(
          `chat-mem: of ${String(offset + count)} chats, ${String(live)} alive and ${String(idle.done)} idle after a successful turn at the reading (${JSON.stringify(idle.seen)})`
        )
        return null
      }
      return footprint
    }
    result.lowMb = result.incomplete.length === 0 ? await step(CHAT_MEMORY_LOW, 0) : null
    if (result.lowMb !== null) {
      result.highMb = await step(CHAT_MEMORY_HIGH - CHAT_MEMORY_LOW, CHAT_MEMORY_LOW)
      result.chats = CHAT_MEMORY_HIGH - CHAT_MEMORY_LOW
    }
    if (
      result.highMb != null &&
      (result.highMb - result.lowMb) / result.chats < MIN_MAIN_MB_PER_CHAT
    ) {
      result.incomplete.push('chat-mem: memory fell as chats started, so a reading was wrong')
    }
  } finally {
    await copy.close()
  }
  removeRunDir(runDir)
  console.log(`[fleet-gate] ${label}: ${JSON.stringify(result)}`)
  return result
}

export function chatMemoryRows(results) {
  const run = results.find((entry) => entry.arm === 'new')
  if (!run) {
    return []
  }
  const label = `main MB/idle chat (${String(CHAT_MEMORY_LOW)}→${String(CHAT_MEMORY_HIGH)})`
  const perChat =
    typeof run.lowMb === 'number' && typeof run.highMb === 'number' && run.chats > 0
      ? (run.highMb - run.lowMb) / run.chats
      : null
  const judged = perChat !== null && run.incomplete.length === 0 && perChat >= MIN_MAIN_MB_PER_CHAT
  return [
    {
      scenario: 'chat-mem',
      metric: { label },
      old: null,
      new: perChat === null ? '—' : Math.round(perChat * 100) / 100,
      verdict: !judged ? 'n/a' : perChat > MAX_MAIN_MB_PER_CHAT ? 'FAIL' : 'ok'
    }
  ]
}
