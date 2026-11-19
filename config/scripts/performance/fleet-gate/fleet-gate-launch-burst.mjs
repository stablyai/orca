// Launch bursts at fleet scale: restart continuation of chats quit mid-turn, then a cold burst of new chats.
// Each chat runs the repo's stream-json Claude stub through the real native-chat launch path (provider ownership included).
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

export const BURST_CHATS = 25
const OWNERSHIP_REFUSAL = /Cannot establish provider process ownership/i
const LAUNCH_WAIT_MS = 120_000

/** A `claude` wrapper that runs the stub and appends one launch-log line per process. */
export function writeClaudeStub(stubDir, repoRoot) {
  fs.mkdirSync(stubDir, { recursive: true })
  const script = path.join(repoRoot, 'tests', 'e2e', 'fixtures', 'structured-claude-stub.cjs')
  const launchLog = path.join(stubDir, 'launches.jsonl')
  const command = path.join(stubDir, 'claude')
  const quote = (value) => `'${value.replaceAll("'", `'\\''`)}'`
  fs.writeFileSync(
    command,
    `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(script)} ${quote(launchLog)} "$@"\n`
  )
  fs.chmodSync(command, 0o755)
  return { command, launchLog }
}

/** Chat launches only: native chats run the CLI in stream-json mode, unlike version and catalog probes. */
function countLaunches(launchLog) {
  if (!fs.existsSync(launchLog)) {
    return 0
  }
  return fs
    .readFileSync(launchLog, 'utf8')
    .split('\n')
    .filter((line) => line.includes('"--input-format"')).length
}

async function waitForLaunches(launchLog, expected, timeoutMs = LAUNCH_WAIT_MS) {
  const deadline = Date.now() + timeoutMs
  while (countLaunches(launchLog) < expected && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 500))
  }
  return countLaunches(launchLog)
}

/** Loads every core while a burst runs, as an update restart under load does; killed when the burst ends. */
export function startCpuLoad(repoRoot, tracker = null) {
  const worker = path.join(repoRoot, 'tests', 'tools', 'benchmarks', 'cpu-pressure-worker.mjs')
  let stopped = false
  let earlyExits = 0
  const children = Array.from({ length: os.availableParallelism() }, () => {
    // An hour outlasts any burst (the burst stops it); the cap only bounds an orphan.
    // Marked and recorded so a gate killed mid-burst doesn't leave every core loaded.
    const args = tracker ? [worker, '3600000', tracker.arg] : [worker, '3600000']
    const child = spawn(process.execPath, args, { stdio: 'ignore' })
    const forget = tracker?.record(child.pid) ?? (() => {})
    child.once('exit', () => {
      earlyExits += stopped ? 0 : 1
      forget()
    })
    return { child, forget }
  })
  /** Stops the load; returns how many workers had already exited, i.e. how much of it was missing. */
  return () => {
    stopped = true
    for (const { child, forget } of children) {
      child.kill('SIGKILL')
      // Our own unreaped child: its pid can't pass to another process, so the SIGKILL settles it.
      forget()
    }
    tracker?.done()
    return earlyExits
  }
}

export async function pointClaudeAtStub(page, command) {
  await page.evaluate(async (stub) => {
    await window.__store.getState().updateSettings({
      nativeChatProviders: { claude: true, codex: true },
      agentCmdOverrides: { claude: stub }
    })
  }, command)
}

/** Creates chats in distinct workspaces, all at once, each with a first message the stub keeps running. */
export async function createChatBurst(page, count, offset, prompt) {
  return page.evaluate(
    async ({ total, skip, text }) => {
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
      const list = await window.api.runtime.call({
        method: 'worktree.list',
        params: { limit: 5000 }
      })
      const worktrees = list.result.worktrees
        .filter((worktree) => /\/wt\/wt-\d{4}$/.test(worktree.path))
        .sort((a, b) => (a.path < b.path ? -1 : 1))
        .slice(skip, skip + total)
      const replies = await Promise.all(
        worktrees.map(async (worktree) => {
          const sessionId = crypto.randomUUID()
          const firstMessage = {
            clientMessageId: crypto.randomUUID(),
            body: { kind: 'message', role: 'user', blocks: [{ type: 'text', text }] }
          }
          const fields = { worktree: `id:${worktree.id}`, agent: 'claude', firstMessage }
          const params = {
            envelope: {
              sessionId,
              clientOperationId: `${Date.now()}-${crypto.randomUUID().replaceAll('-', '')}`,
              expectedRuntimeFence: null,
              payloadFingerprint: await sha(
                canon({ method: 'agentSession.create', sessionId, fields })
              )
            },
            ...fields
          }
          const reply = await window.api.runtime
            .call({ method: 'agentSession.create', params })
            .catch((error) => ({ ok: false, error: String(error?.message ?? error) }))
          return reply.ok && reply.result?.ok !== false
            ? { sessionId }
            : {
                refusal: JSON.stringify(reply.error ?? reply.result?.refusal ?? reply).slice(0, 200)
              }
        })
      )
      return {
        requested: worktrees.length,
        sessionIds: replies.filter((reply) => reply.sessionId).map((reply) => reply.sessionId),
        refused: replies.filter((reply) => reply.refusal).map((reply) => reply.refusal)
      }
    },
    { total: count, skip: offset, text: prompt }
  )
}

/**
 * Continues this burst's restart offers in one call, as the dialog's Continue does, and tallies the outcomes.
 * Offers are matched to the burst's own session ids, so a profile's unrelated resumable session can't stand in.
 */
export async function continueAfterRestart(page, burstSessionIds) {
  return page.evaluate(async (expected) => {
    const listed = await window.api.runtime.call({
      method: 'agentSession.restartResumable',
      params: {}
    })
    const offered = (listed.result?.sessions?.map((session) => session.sessionId) ?? []).filter(
      (sessionId) => expected.includes(sessionId)
    )
    if (offered.length === 0) {
      return { offered: 0, outcomes: {}, problems: [] }
    }
    const reply = await window.api.runtime.call({
      method: 'agentSession.restartContinue',
      params: { sessionIds: offered }
    })
    const result = reply.result ?? {}
    const outcomes = {}
    const problems = []
    for (const entry of [...(result.resumed ?? []), ...(result.continued ?? [])]) {
      outcomes[entry.outcome] = (outcomes[entry.outcome] ?? 0) + 1
      if (/refus|fail|error/i.test(String(entry.outcome))) {
        problems.push(`${entry.outcome}: ${String(entry.reason ?? '').slice(0, 160)}`)
      }
    }
    for (const failure of result.failed ?? []) {
      problems.push(`failed: ${String(failure.reason ?? failure.outcome).slice(0, 160)}`)
    }
    if (!reply.ok) {
      problems.push(`call: ${JSON.stringify(reply.error).slice(0, 160)}`)
    }
    return { offered: offered.length, outcomes, problems }
  }, burstSessionIds)
}

/** Ownership refusals anywhere the copy logs them: its stderr and the trace logs under user data. */
export function countOwnershipRefusals(stderrText, userDataDir) {
  let count = (stderrText.match(new RegExp(OWNERSHIP_REFUSAL.source, 'gi')) ?? []).length
  const visit = (dir, depth) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name)
      if (entry.isDirectory() && depth < 3) {
        visit(full, depth + 1)
      } else if (entry.isFile() && /\.(log|ndjson|jsonl)$/.test(entry.name)) {
        if (fs.statSync(full).size < 64 * 1024 * 1024) {
          const text = fs.readFileSync(full, 'utf8')
          count += (text.match(new RegExp(OWNERSHIP_REFUSAL.source, 'gi')) ?? []).length
        }
      }
    }
  }
  if (fs.existsSync(userDataDir)) {
    visit(userDataDir, 0)
  }
  return count
}

export { countLaunches, waitForLaunches }
