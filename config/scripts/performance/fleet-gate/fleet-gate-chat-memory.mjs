// Idle-chat memory slope: main RSS growth per live idle chat, judged on NEW alone.
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

const CHAT_MEMORY_LOW = 10
const CHAT_MEMORY_HIGH = 200
// Pressure-released same-build runs on the seed stay well under this; a retained 1 MB per chat reads ~1.
const MAX_MAIN_MB_PER_CHAT = 0.25
const RELEASE_WAIT_MS = 60_000
const SAMPLE_WINDOW_MS = 60_000
const SAMPLE_EVERY_MS = 5_000

/**
 * Main RSS once V8 has handed back the freed pages of the last chat burst (a memory-pressure signal, then a
 * minute), as the lowest of 12 samples. Without it those pages linger for minutes and swamp the slope.
 */
async function sampleMainRssMb(electronApp, page) {
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
    const rss = await electronApp.evaluate(() => process.memoryUsage().rss)
    lowest = Math.min(lowest, rss / 1048576)
    await new Promise((resolve) => setTimeout(resolve, SAMPLE_EVERY_MS))
  }
  return Math.round(lowest * 10) / 10
}

/** Main RSS at 10 then 200 live idle chats, each read after the same long settle, so burst garbage has gone. */
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
    await new Promise((resolve) => setTimeout(resolve, options.settleMs))
    await closeStartupDialogs(copy.page, result.incomplete)
    const step = async (count, offset) => {
      const batch = await createChatBurst(copy.page, count, offset, 'fleet gate idle turn')
      const launched = await waitForLaunches(stub.launchLog, offset + count, 300_000)
      if (batch.requested !== count || batch.refused.length > 0 || launched < offset + count) {
        result.short = true
        result.incomplete.push(
          `chat-mem: ${String(launched)} of ${String(offset + count)} chats started (${String(batch.refused.length)} refused)`
        )
      }
      await new Promise((resolve) => setTimeout(resolve, options.chatSettleMs))
      return sampleMainRssMb(copy.app, copy.page)
    }
    result.lowRssMb = await step(CHAT_MEMORY_LOW, 0)
    result.highRssMb = await step(CHAT_MEMORY_HIGH - CHAT_MEMORY_LOW, CHAT_MEMORY_LOW)
    result.chats = CHAT_MEMORY_HIGH - CHAT_MEMORY_LOW
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
  const measured =
    typeof run.lowRssMb === 'number' && typeof run.highRssMb === 'number' && run.chats > 0
  const perChat = measured ? (run.highRssMb - run.lowRssMb) / run.chats : null
  return [
    {
      scenario: 'chat-mem',
      metric: { label },
      old: null,
      new: perChat === null ? '—' : Math.round(perChat * 100) / 100,
      verdict: !measured || run.short ? 'n/a' : perChat > MAX_MAIN_MB_PER_CHAT ? 'FAIL' : 'ok'
    }
  ]
}
