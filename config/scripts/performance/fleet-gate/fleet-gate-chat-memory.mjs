// Idle-chat memory slope: main's memory growth per live idle chat, judged on NEW alone.
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
// Main today reads 0.27-0.40 MB per live idle chat on the seed; a build keeping 1 MB more per chat reads ~1.3.
const MAX_MAIN_MB_PER_CHAT = 0.75
const RELEASE_WAIT_MS = 60_000
const SAMPLE_WINDOW_MS = 60_000
const SAMPLE_EVERY_MS = 5_000

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

/** Main's footprint at 10 then 200 live idle chats, each read after the same long settle, so burst garbage has gone. */
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
      return sampleMainFootprintMb(copy.app, copy.page)
    }
    result.lowMb = await step(CHAT_MEMORY_LOW, 0)
    result.highMb = await step(CHAT_MEMORY_HIGH - CHAT_MEMORY_LOW, CHAT_MEMORY_LOW)
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
  const measured = typeof run.lowMb === 'number' && typeof run.highMb === 'number' && run.chats > 0
  const perChat = measured ? (run.highMb - run.lowMb) / run.chats : null
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
