// Whole-app memory soak: Orca's own processes must stay flat over hours with chats running at fleet scale. NEW only.
import fs from 'node:fs'
import path from 'node:path'
import { idleLiveChatCount, liveChatCount } from './fleet-gate-chat-memory.mjs'
import { copyProfile, readDaemonPids } from './fleet-gate-copies.mjs'
import {
  createChatBurst,
  pointClaudeAtStub,
  waitForLaunches,
  writeClaudeStub
} from './fleet-gate-launch-burst.mjs'
import { removeRunDir } from './fleet-gate-run-dirs.mjs'
import { closeStartupDialogs } from './fleet-gate-scenarios.mjs'
import { readFleetCensus, SEED_SHAPE } from './fleet-gate-synthetic-seed.mjs'

const SOAK_LOW = 10
const SOAK_HIGH = 200
// The flat bar: the end may exceed the 10-chat baseline by at most 10% or 100 MB, whichever is larger.
const MAX_GROWTH_SHARE = 0.1
const MIN_GROWTH_BOUND_MB = 100
// One chat is shown and given a long turn per tick, so 1 h of load visits all 200 chats about 1.8 times.
const TURN_EVERY_MS = 10_000
const CHECKPOINT_EVERY_MS = 15 * 60_000
const RELEASE_WAIT_MS = 60_000
const SAMPLE_WINDOW_MS = 60_000
const SAMPLE_EVERY_MS = 5_000
const IDLE_WAIT_MS = 300_000
const IDLE_POLL_MS = 10_000
// More misses than this means the workload didn't run, so the reading isn't judged.
const MAX_MISSED_SHARE = 0.05
const SOAK_PROMPT = 'fleet gate soak turn, long-reply'

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/** Proportional set size plus swapped share, or null when the process can't be read (gone or not ours to read). */
function linuxProcessMb(pid) {
  try {
    const rollup = fs.readFileSync(`/proc/${String(pid)}/smaps_rollup`, 'utf8')
    const kb = (field) =>
      Number(new RegExp(`^${field}:\\s+(\\d+)`, 'm').exec(rollup)?.[1] ?? Number.NaN)
    const mb = (kb('Pss') + (kb('SwapPss') || 0)) / 1024
    return Number.isFinite(mb) ? mb : null
  } catch {
    return null
  }
}

/**
 * Orca's Node children Electron doesn't list (the terminal daemon that hosts chat relays, the plugin host, the
 * session scanner): descendants of main or the copy's daemon running the same Electron binary, so agents,
 * shells and git are left out.
 */
function linuxNodeChildren(mainPid, daemonPids, listed) {
  const exe = (pid) => {
    try {
      return fs.readlinkSync(`/proc/${String(pid)}/exe`)
    } catch {
      return null
    }
  }
  const electronExe = exe(mainPid)
  const children = new Map()
  for (const entry of fs.readdirSync('/proc')) {
    if (!/^\d+$/.test(entry)) {
      continue
    }
    try {
      // The command name can hold spaces and parens, so the parent pid is read after its closing paren.
      const stat = fs.readFileSync(`/proc/${entry}/stat`, 'utf8')
      const ppid = Number(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[1])
      children.set(ppid, [...(children.get(ppid) ?? []), Number(entry)])
    } catch {}
  }
  const found = new Set(daemonPids)
  const queue = [mainPid, ...daemonPids]
  while (queue.length > 0) {
    for (const child of children.get(queue.shift()) ?? []) {
      if (!found.has(child) && exe(child) === electronExe) {
        found.add(child)
        queue.push(child)
      }
    }
  }
  return [...found].filter((pid) => !listed.has(pid))
}

/**
 * Every Orca process (main, renderers, GPU, utility, and on Linux its Node children) after a GC and a
 * memory-pressure signal, as the lowest total of 12 samples over a minute, with that sample's split by type.
 * A sample with an unreadable process is dropped rather than counted low.
 */
async function sampleAppMb(electronApp, page, userDataDir) {
  const cdp = await page.context().newCDPSession(page)
  try {
    await cdp.send('HeapProfiler.collectGarbage')
    await cdp.send('Memory.simulatePressureNotification', { level: 'critical' })
  } finally {
    await cdp.detach().catch(() => {})
  }
  await sleep(RELEASE_WAIT_MS)
  let lowest = null
  let dropped = 0
  const deadline = Date.now() + SAMPLE_WINDOW_MS
  while (Date.now() < deadline) {
    const { mainPid, metrics } = await electronApp.evaluate(({ app }) => ({
      mainPid: process.pid,
      metrics: app.getAppMetrics().map((metric) => ({
        pid: metric.pid,
        type: metric.type,
        workingSetKb: metric.memory.workingSetSize
      }))
    }))
    const processes = metrics.map(({ pid, type, workingSetKb }) => ({ pid, type, workingSetKb }))
    if (process.platform === 'linux') {
      const listed = new Set(processes.map(({ pid }) => pid))
      for (const pid of linuxNodeChildren(mainPid, readDaemonPids(userDataDir), listed)) {
        processes.push({ pid, type: 'Node' })
      }
    }
    const byType = {}
    let total = 0
    let unreadable = false
    for (const entry of processes) {
      const mb =
        process.platform === 'linux' ? linuxProcessMb(entry.pid) : entry.workingSetKb / 1024
      if (mb === null) {
        unreadable = true
        break
      }
      byType[entry.type] = (byType[entry.type] ?? 0) + mb
      total += mb
    }
    if (unreadable) {
      dropped += 1
    } else if (lowest === null || total < lowest.totalMb) {
      lowest = {
        totalMb: Math.round(total),
        processes: processes.length,
        mainPid,
        byType: Object.fromEntries(
          Object.entries(byType).map(([type, mb]) => [type, Math.round(mb)])
        )
      }
    }
    await sleep(SAMPLE_EVERY_MS)
  }
  return lowest === null ? null : { ...lowest, droppedSamples: dropped }
}

/** Shows the chat's workspace and its tab, as a click in the sidebar and tab strip does. */
async function showChat(page, { sessionId, worktreeId }) {
  return page.evaluate(
    ({ session, worktree }) => {
      const state = window.__store.getState()
      if (state.activeWorktreeId !== worktree) {
        state.setActiveWorktree(worktree)
      }
      const tab = (window.__store.getState().unifiedTabsByWorktree?.[worktree] ?? []).find(
        (candidate) =>
          candidate.contentType === 'agent-session' &&
          (candidate.entityId === session || candidate.id === session)
      )
      if (!tab) {
        return false
      }
      window.__store.getState().activateTab(tab.id, { worktreeId: worktree })
      return true
    },
    { session: sessionId, worktree: worktreeId }
  )
}

/** A follow-up user turn through the same mutation envelope the composer sends. */
async function sendTurn(page, sessionId, text) {
  return page.evaluate(
    async ({ session, prompt }) => {
      const canon = (value) =>
        value === null || typeof value !== 'object'
          ? JSON.stringify(value ?? null)
          : Array.isArray(value)
            ? `[${value.map(canon).join(',')}]`
            : `{${Object.entries(value)
                .filter(([, entry]) => entry !== undefined)
                .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
                .map(([key, entry]) => `${JSON.stringify(key)}:${canon(entry)}`)
                .join(',')}}`
      const sha = async (value) =>
        [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)))]
          .map((byte) => byte.toString(16).padStart(2, '0'))
          .join('')
      const tail = await window.api.runtime.call({
        method: 'agentSession.history',
        params: { sessionId: session, direction: 'tail', limit: 1 }
      })
      const fence = tail.result?.page?.fence ?? tail.result?.fence
      if (typeof fence !== 'number') {
        return false
      }
      const fields = {
        body: { kind: 'message', role: 'user', blocks: [{ type: 'text', text: prompt }] },
        delivery: 'queue-if-active'
      }
      const reply = await window.api.runtime
        .call({
          method: 'agentSession.send',
          params: {
            envelope: {
              sessionId: session,
              clientOperationId: `${Date.now()}-${crypto.randomUUID().replaceAll('-', '')}`,
              expectedRuntimeFence: fence,
              payloadFingerprint: await sha(
                canon({ method: 'agentSession.send', sessionId: session, fields })
              )
            },
            ...fields
          }
        })
        .catch(() => ({ ok: false }))
      return reply.ok === true && reply.result?.ok !== false
    },
    { session: sessionId, prompt: text }
  )
}

/** Orca's footprint at 10 shown chats, then after 190 more start and all 200 take turns and are shown for N hours. */
export async function appMemorySoakOnce({
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
  const label = `soak-${arm}-${sha.slice(0, 11)}`
  const result = {
    arm,
    sha,
    platform: process.platform,
    soakHours: options.soakHours,
    checkpoints: [],
    incomplete: []
  }
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
    // Running chats is the load under test, so the idle stop must not end them mid-soak.
    await copy.page.evaluate(() =>
      window.__store.getState().updateSettings({ nativeChatIdleStopMinutes: 0 })
    )
    await sleep(options.settleMs)
    await closeStartupDialogs(copy.page, result.incomplete)
    const { workspaces } = await readFleetCensus(copy.page)
    const fleet = SEED_SHAPE.worktrees + SEED_SHAPE.folders
    if (!(workspaces >= fleet)) {
      result.incomplete.push(
        `soak: fleet loaded ${String(workspaces)} of ${String(fleet)} workspaces`
      )
      return result
    }
    const sessions = []
    const start = async (count, offset) => {
      const batch = await createChatBurst(copy.page, count, offset, SOAK_PROMPT)
      sessions.push(...batch.sessions)
      if (batch.requested !== count || batch.refused.length > 0) {
        result.incomplete.push(
          `soak: ${String(batch.requested)} of ${String(count)} chats requested, ${String(batch.refused.length)} refused`
        )
        return false
      }
      if ((await waitForLaunches(stub.launchLog, offset + count, 300_000)) < offset + count) {
        result.incomplete.push(`soak: fewer than ${String(offset + count)} chats started`)
        return false
      }
      return waitIdle(offset + count)
    }
    const waitIdle = async (expected) => {
      const ids = sessions.map((session) => session.sessionId)
      const idleBy = Date.now() + IDLE_WAIT_MS
      let ready = await idleLiveChatCount(copy.page, ids)
      while (ready.done < expected && Date.now() < idleBy) {
        await sleep(IDLE_POLL_MS)
        ready = await idleLiveChatCount(copy.page, ids)
      }
      if (ready.done < expected) {
        result.incomplete.push(
          `soak: ${String(ready.done)} of ${String(expected)} chats idle after a successful turn (${JSON.stringify(ready.seen)})`
        )
        return false
      }
      return true
    }
    // A renderer reload or a main restart resets memory, so a reading across one would hide growth.
    const pageOrigin = () => copy.page.evaluate(() => performance.timeOrigin)
    const checkpoint = async (name) => {
      await sleep(options.chatSettleMs)
      const reading = await sampleAppMb(copy.app, copy.page, userDataDir)
      const origin = await pageOrigin()
      result.checkpoints.push({ name, at: Date.now(), origin, ...reading })
      console.log(`[fleet-gate] ${label} ${name}: ${JSON.stringify(reading)}`)
      if (reading === null) {
        result.incomplete.push(`soak: no readable memory sample at ${name}`)
      } else if (result.baseline && reading.mainPid !== result.baseline.mainPid) {
        result.incomplete.push(`soak: main restarted before ${name}`)
      } else if (result.baselineOrigin !== undefined && origin !== result.baselineOrigin) {
        result.incomplete.push(`soak: the window reloaded before ${name}`)
      }
      return reading
    }

    if (!(await start(SOAK_LOW, 0))) {
      return result
    }
    for (const session of sessions) {
      await showChat(copy.page, session)
      await sleep(2_000)
    }
    result.baseline = await checkpoint('10 chats')
    result.baselineOrigin = await pageOrigin()
    if (result.baseline === null) {
      return result
    }
    if (!(await start(SOAK_HIGH - SOAK_LOW, SOAK_LOW))) {
      return result
    }
    const soakStart = Date.now()
    // Checkpoints pause the turns, so their time is added back: --soak-hours is hours of load.
    let soakEnd = soakStart + options.soakHours * 3_600_000
    let nextCheckpoint = Date.now() + CHECKPOINT_EVERY_MS
    const counts = { turns: 0, sendMissed: 0, showMissed: 0 }
    while (Date.now() < soakEnd) {
      const tickStart = Date.now()
      const session = sessions[counts.turns % sessions.length]
      counts.showMissed += (await showChat(copy.page, session)) ? 0 : 1
      counts.sendMissed += (await sendTurn(copy.page, session.sessionId, SOAK_PROMPT)) ? 0 : 1
      counts.turns += 1
      if (Date.now() >= nextCheckpoint && Date.now() < soakEnd) {
        const paused = Date.now()
        await checkpoint(`${String(Math.round((Date.now() - soakStart) / 60_000))} min`)
        soakEnd += Date.now() - paused
        nextCheckpoint = Date.now() + CHECKPOINT_EVERY_MS
      }
      await sleep(Math.max(0, tickStart + TURN_EVERY_MS - Date.now()))
    }
    Object.assign(result, counts)
    for (const [key, missed] of [
      ['sends', counts.sendMissed],
      ['shows', counts.showMissed]
    ]) {
      if (missed > counts.turns * MAX_MISSED_SHARE) {
        result.incomplete.push(`soak: ${String(missed)} of ${String(counts.turns)} ${key} failed`)
      }
    }
    if (!(await waitIdle(SOAK_HIGH))) {
      return result
    }
    // Accepted sends prove nothing on their own: count the soak turns the agents actually received.
    const inputs = stub.launchLog.replace(/\.jsonl$/, '-inputs.jsonl')
    const received = fs.existsSync(inputs)
      ? fs
          .readFileSync(inputs, 'utf8')
          .split('\n')
          .filter((line) => line.includes(SOAK_PROMPT)).length
      : 0
    result.received = received
    const expected = SOAK_HIGH + counts.turns
    if (received < expected * (1 - MAX_MISSED_SHARE)) {
      result.incomplete.push(
        `soak: agents received ${String(received)} of ${String(expected)} turns`
      )
    }
    result.end = await checkpoint('end')
    const bound = Math.max(result.baseline.totalMb * MAX_GROWTH_SHARE, MIN_GROWTH_BOUND_MB)
    // Memory falling past the bound means a reading was wrong, not that the app shrank.
    if (result.end !== null && result.end.totalMb - result.baseline.totalMb < -bound) {
      result.incomplete.push('soak: memory fell below the baseline, so a reading was wrong')
    }
    const live = liveChatCount(stub.launchLog)
    if (live < SOAK_HIGH) {
      result.incomplete.push(`soak: ${String(live)} of ${String(SOAK_HIGH)} chats alive at the end`)
    }
  } finally {
    await copy.close()
    removeRunDir(runDir)
    console.log(`[fleet-gate] ${label}: ${JSON.stringify(result)}`)
  }
  return result
}

/** One soak; a failed step reports INCOMPLETE instead of losing what the gate measured before it. */
export function appMemorySoakSafe(args) {
  return appMemorySoakOnce(args).catch((error) => ({
    arm: args.arm,
    soakHours: args.options.soakHours,
    incomplete: [`soak: ${String(error?.message ?? error)}`]
  }))
}

export function appMemorySoakRows(results) {
  const run = results.find((entry) => entry.arm === 'new')
  if (!run) {
    return []
  }
  const baseline = run.baseline?.totalMb
  const end = run.end?.totalMb
  const growth = typeof baseline === 'number' && typeof end === 'number' ? end - baseline : null
  const bound = Math.max((baseline ?? 0) * MAX_GROWTH_SHARE, MIN_GROWTH_BOUND_MB)
  // Off Linux the reading is resident memory without Orca's Node children, so it is shown but not judged.
  const judged = growth !== null && run.incomplete.length === 0 && run.platform === 'linux'
  return [
    {
      scenario: 'soak',
      metric: {
        label: `app MB growth (${String(SOAK_LOW)} chats → ${String(SOAK_HIGH)} chats + ${String(run.soakHours)} h, bound ${String(Math.round(bound))})`
      },
      old: null,
      new: growth === null ? '—' : growth,
      verdict: !judged ? 'n/a' : growth > bound ? 'FAIL' : 'ok'
    }
  ]
}
