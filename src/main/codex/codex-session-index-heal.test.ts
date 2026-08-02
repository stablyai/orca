import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  appendFileSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import type { CodexAppServerInvocation } from './codex-app-server-session'
import { createCodexSessionBackfillAuditWriter } from './codex-session-backfill-audit'
import { CODEX_SESSION_INDEX_HEAL_VERSION } from './codex-session-index-heal-state'
import {
  runCodexSessionIndexHeal,
  type CodexSessionIndexHealPaths
} from './codex-session-index-heal'

// Stub codex app-server speaking the JSONL protocol for the heal pass:
// initialize → initialized → thread/read×N. Scenario-driven via STUB_CONFIG;
// every thread/read is appended to readLogFile so tests can assert order,
// batching (one spawn appends a server-start marker), and skip behavior.
const STUB_SERVER_SOURCE = `
const fs = require('node:fs')
const config = JSON.parse(process.env.STUB_CONFIG)
fs.appendFileSync(config.readLogFile, JSON.stringify({ serverStart: true }) + '\\n')
let buffer = ''
let inFlight = 0
let maxInFlight = 0
function send(message) {
  process.stdout.write(JSON.stringify(message) + '\\n')
}
if (config.scenario === 'no-subcommand') {
  process.stderr.write("error: unrecognized subcommand 'app-server'\\n")
  process.exit(2)
}
process.stdin.setEncoding('utf8')
process.stdin.on('data', (chunk) => {
  buffer += chunk
  let index
  while ((index = buffer.indexOf('\\n')) !== -1) {
    const line = buffer.slice(0, index).trim()
    buffer = buffer.slice(index + 1)
    if (!line) continue
    const message = JSON.parse(line)
    if (message.method === 'initialize') {
      send({ id: message.id, result: { userAgent: 'stub/0.0.0', codexHome: process.env.CODEX_HOME } })
      continue
    }
    if (message.method === 'initialized') continue
    if (message.method === 'thread/read') {
      const threadId = message.params.threadId
      if (config.scenario === 'unknown-method') {
        send({ id: message.id, error: { code: -32601, message: 'Method not found' } })
        continue
      }
      inFlight += 1
      maxInFlight = Math.max(maxInFlight, inFlight)
      setTimeout(() => {
        inFlight -= 1
        fs.appendFileSync(config.readLogFile, JSON.stringify({ threadId, maxInFlight }) + '\\n')
        if ((config.missingThreadIds || []).includes(threadId)) {
          send({ id: message.id, error: { code: -32600, message: 'no rollout found for thread id ' + threadId } })
          return
        }
        if ((config.failingThreadIds || []).includes(threadId)) {
          send({ id: message.id, error: { code: -32600, message: 'failed to parse rollout' } })
          return
        }
        if ((config.busyThreadIds || []).includes(threadId)) {
          send({ id: message.id, error: { code: -32600, message: 'database is locked' } })
          return
        }
        if (config.scenario === 'die-mid-batch' && threadId === config.dieOnThreadId) {
          process.exit(7)
        }
        send({ id: message.id, result: { thread: { id: threadId } } })
      }, 5)
      continue
    }
  }
})
process.stdin.on('end', () => process.exit(0))
`

let tempRoots: string[] = []

afterEach(() => {
  for (const root of tempRoots) {
    rmSync(root, { recursive: true, force: true })
  }
  tempRoots = []
})

function threadId(suffix: string): string {
  return `019f0000-1111-7222-8333-${suffix.padStart(12, '0')}`
}

function rolloutTarget(sessionsRoot: string, stamp: string, id: string): string {
  return join(sessionsRoot, '2026', '07', '01', `rollout-${stamp}-${id}.jsonl`)
}

function createHealRig(options: {
  scenario?: string
  auditedThreads?: { stamp: string; id: string; action?: string }[]
  missingThreadIds?: string[]
  failingThreadIds?: string[]
  busyThreadIds?: string[]
  dieOnThreadId?: string
}): {
  paths: CodexSessionIndexHealPaths
  readLogFile: string
  buildInvocation: (systemCodexHomePath: string, timeoutMs: number) => CodexAppServerInvocation
  readLog: () => { serverStarts: number; threadIds: string[]; maxInFlight: number }
} {
  const root = mkdtempSync(join(tmpdir(), 'orca-codex-heal-'))
  tempRoots.push(root)
  const systemSessionsRoot = join(root, 'real-home', 'sessions')
  const stateDir = join(root, 'state')
  mkdirSync(stateDir, { recursive: true })
  const paths: CodexSessionIndexHealPaths = {
    auditLogPath: join(stateDir, 'audit.jsonl'),
    systemSessionsRoot,
    healLedgerPath: join(stateDir, 'index-heal-ledger.jsonl'),
    healMarkerPath: join(stateDir, 'index-heal-complete.json')
  }
  for (const [index, audited] of (options.auditedThreads ?? []).entries()) {
    appendFileSync(
      paths.auditLogPath,
      `${JSON.stringify({
        at: '2026-07-01T00:00:00.000Z',
        action: audited.action ?? 'hardlink',
        source: '/managed/sessions/x.jsonl',
        target: rolloutTarget(systemSessionsRoot, audited.stamp, audited.id),
        recordId: `audit-record-${index}`
      })}\n`
    )
  }
  const stubPath = join(root, 'stub-app-server.cjs')
  writeFileSync(stubPath, STUB_SERVER_SOURCE)
  const readLogFile = join(root, 'reads.jsonl')
  writeFileSync(readLogFile, '')
  return {
    paths,
    readLogFile,
    buildInvocation: (_systemCodexHomePath, timeoutMs) => ({
      command: process.execPath,
      args: [stubPath],
      env: {
        STUB_CONFIG: JSON.stringify({
          scenario: options.scenario ?? 'ok',
          readLogFile,
          missingThreadIds: options.missingThreadIds ?? [],
          failingThreadIds: options.failingThreadIds ?? [],
          busyThreadIds: options.busyThreadIds ?? [],
          dieOnThreadId: options.dieOnThreadId
        })
      },
      timeoutMs
    }),
    readLog: () => {
      const lines = readFileSync(readLogFile, 'utf-8')
        .split('\n')
        .filter(Boolean)
        .map(
          (line) =>
            JSON.parse(line) as { serverStart?: boolean; threadId?: string; maxInFlight?: number }
        )
      return {
        serverStarts: lines.filter((line) => line.serverStart).length,
        threadIds: lines.map((line) => line.threadId).filter((id): id is string => Boolean(id)),
        maxInFlight: Math.max(0, ...lines.map((line) => line.maxInFlight ?? 0))
      }
    }
  }
}

function readLedgerOutcomes(paths: CodexSessionIndexHealPaths): Record<string, string> {
  let contents = ''
  try {
    contents = readFileSync(paths.healLedgerPath, 'utf-8')
  } catch {
    return {}
  }
  const outcomes: Record<string, string> = {}
  for (const line of contents.split('\n').filter(Boolean)) {
    try {
      const record = JSON.parse(line) as { threadId: string; outcome: string }
      outcomes[record.threadId] = record.outcome
    } catch {
      // Torn tails are quarantined by the next append and ignored by readers.
    }
  }
  return outcomes
}

describe('runCodexSessionIndexHeal', () => {
  it('reads every backfilled session recent-first and completes with a marker', async () => {
    const rig = createHealRig({
      auditedThreads: [
        { stamp: '2026-07-01T10-00-00', id: threadId('1') },
        { stamp: '2026-07-03T10-00-00', id: threadId('3'), action: 'copy' },
        { stamp: '2026-07-02T10-00-00', id: threadId('2'), action: 'existing' }
      ]
    })

    const summary = await runCodexSessionIndexHeal(rig.paths, {
      buildInvocation: rig.buildInvocation,
      interBatchDelayMs: 0
    })

    expect(summary).toMatchObject({
      outcome: 'completed',
      pendingThreads: 3,
      healedThreads: 3,
      missingThreads: 0,
      failedThreads: 0
    })
    expect(rig.readLog().threadIds).toEqual([threadId('3'), threadId('2'), threadId('1')])
    expect(readLedgerOutcomes(rig.paths)).toEqual({
      [threadId('1')]: 'healed',
      [threadId('2')]: 'healed',
      [threadId('3')]: 'healed'
    })
    const marker = JSON.parse(readFileSync(rig.paths.healMarkerPath, 'utf-8')) as {
      systemSessionsRoot: string
      healedThreads: number
    }
    expect(marker.systemSessionsRoot).toBe(rig.paths.systemSessionsRoot)
    expect(marker.healedThreads).toBe(3)
  })

  it('is a no-op when the marker matches the audit ledger size', async () => {
    const rig = createHealRig({
      auditedThreads: [{ stamp: '2026-07-01T10-00-00', id: threadId('1') }]
    })
    const first = await runCodexSessionIndexHeal(rig.paths, {
      buildInvocation: rig.buildInvocation,
      interBatchDelayMs: 0
    })
    expect(first.outcome).toBe('completed')
    const second = await runCodexSessionIndexHeal(rig.paths, {
      buildInvocation: rig.buildInvocation,
      interBatchDelayMs: 0
    })
    expect(second.outcome).toBe('up-to-date')
    // One spawn from the first run only — the no-op run must not hit the CLI.
    expect(rig.readLog().serverStarts).toBe(1)
  })

  it('resumes only unprocessed sessions when the audit ledger grows', async () => {
    const rig = createHealRig({
      auditedThreads: [{ stamp: '2026-07-01T10-00-00', id: threadId('1') }]
    })
    await runCodexSessionIndexHeal(rig.paths, {
      buildInvocation: rig.buildInvocation,
      interBatchDelayMs: 0
    })
    appendFileSync(
      rig.paths.auditLogPath,
      `${JSON.stringify({
        action: 'hardlink',
        target: rolloutTarget(rig.paths.systemSessionsRoot, '2026-07-04T10-00-00', threadId('4'))
      })}\n`
    )

    const summary = await runCodexSessionIndexHeal(rig.paths, {
      buildInvocation: rig.buildInvocation,
      interBatchDelayMs: 0
    })

    expect(summary).toMatchObject({ outcome: 'completed', pendingThreads: 1, healedThreads: 1 })
    expect(rig.readLog().threadIds).toEqual([threadId('1'), threadId('4')])
  })

  it('backs off failed sessions and retries them later while missing stays terminal', async () => {
    const rig = createHealRig({
      auditedThreads: [
        { stamp: '2026-07-01T10-00-00', id: threadId('1') },
        { stamp: '2026-07-02T10-00-00', id: threadId('2') },
        { stamp: '2026-07-03T10-00-00', id: threadId('3') }
      ],
      missingThreadIds: [threadId('2')],
      failingThreadIds: [threadId('1')]
    })

    const summary = await runCodexSessionIndexHeal(rig.paths, {
      buildInvocation: rig.buildInvocation,
      interBatchDelayMs: 0
    })

    expect(summary).toMatchObject({
      outcome: 'completed',
      healedThreads: 1,
      missingThreads: 1,
      failedThreads: 1
    })
    expect(readLedgerOutcomes(rig.paths)).toEqual({
      [threadId('1')]: 'failed',
      [threadId('2')]: 'missing',
      [threadId('3')]: 'healed'
    })

    const again = await runCodexSessionIndexHeal(rig.paths, {
      buildInvocation: rig.buildInvocation,
      interBatchDelayMs: 0
    })
    expect(again.outcome).toBe('up-to-date')

    const marker = JSON.parse(readFileSync(rig.paths.healMarkerPath, 'utf-8')) as {
      retryableFailureAt: number
    }
    marker.retryableFailureAt = 0
    writeFileSync(rig.paths.healMarkerPath, `${JSON.stringify(marker)}\n`, 'utf-8')
    const retried = await runCodexSessionIndexHeal(rig.paths, {
      buildInvocation: (home, timeoutMs) => {
        const invocation = rig.buildInvocation(home, timeoutMs)
        return {
          ...invocation,
          env: {
            STUB_CONFIG: JSON.stringify({
              scenario: 'ok',
              readLogFile: rig.readLogFile,
              missingThreadIds: [],
              failingThreadIds: []
            })
          }
        }
      },
      interBatchDelayMs: 0
    })
    expect(retried).toMatchObject({ outcome: 'completed', pendingThreads: 1, healedThreads: 1 })
    expect(rig.readLog().threadIds.at(-1)).toBe(threadId('1'))
    expect(readLedgerOutcomes(rig.paths)[threadId('1')]).toBe('healed')
  })

  it('retries a missing thread when a later backfill republishes its rollout', async () => {
    const id = threadId('1')
    const rig = createHealRig({
      auditedThreads: [{ stamp: '2026-07-01T10-00-00', id }],
      missingThreadIds: [id]
    })

    const missing = await runCodexSessionIndexHeal(rig.paths, {
      buildInvocation: rig.buildInvocation,
      interBatchDelayMs: 0
    })
    expect(missing).toMatchObject({ outcome: 'completed', missingThreads: 1 })

    await createCodexSessionBackfillAuditWriter(rig.paths.auditLogPath)({
      action: 'existing',
      target: rolloutTarget(rig.paths.systemSessionsRoot, '2026-07-01T10-00-00', id)
    })
    const healed = await runCodexSessionIndexHeal(rig.paths, {
      buildInvocation: (home, timeoutMs) => {
        const invocation = rig.buildInvocation(home, timeoutMs)
        return {
          ...invocation,
          env: {
            STUB_CONFIG: JSON.stringify({
              scenario: 'ok',
              readLogFile: rig.readLogFile,
              missingThreadIds: [],
              failingThreadIds: []
            })
          }
        }
      },
      interBatchDelayMs: 0
    })

    expect(healed).toMatchObject({ outcome: 'completed', pendingThreads: 1, healedThreads: 1 })
    expect(rig.readLog().threadIds).toEqual([id, id])
  })

  it('keeps a processed outcome readable after a torn heal-ledger tail', async () => {
    const id = threadId('1')
    const rig = createHealRig({
      auditedThreads: [{ stamp: '2026-07-01T10-00-00', id }]
    })
    writeFileSync(rig.paths.healLedgerPath, '{"torn":', 'utf-8')

    const first = await runCodexSessionIndexHeal(rig.paths, {
      buildInvocation: rig.buildInvocation,
      interBatchDelayMs: 0
    })
    expect(first).toMatchObject({ outcome: 'completed', healedThreads: 1 })

    rmSync(rig.paths.healMarkerPath)
    const resumed = await runCodexSessionIndexHeal(rig.paths, {
      buildInvocation: rig.buildInvocation,
      interBatchDelayMs: 0
    })
    expect(resumed).toMatchObject({ outcome: 'completed', pendingThreads: 0 })
    expect(rig.readLog().serverStarts).toBe(1)
  })

  it('splits work into batches with one server session each and bounded concurrency', async () => {
    const rig = createHealRig({
      auditedThreads: Array.from({ length: 5 }, (_, index) => ({
        stamp: `2026-07-0${index + 1}T10-00-00`,
        id: threadId(String(index + 1))
      }))
    })

    const summary = await runCodexSessionIndexHeal(rig.paths, {
      buildInvocation: rig.buildInvocation,
      readsPerServerSession: 2,
      readConcurrency: 2,
      interBatchDelayMs: 0
    })

    expect(summary).toMatchObject({ outcome: 'completed', healedThreads: 5 })
    const log = rig.readLog()
    expect(log.serverStarts).toBe(3)
    expect(log.maxInFlight).toBeLessThanOrEqual(2)
  })

  it('caps overrides at the production batch and concurrency limits', async () => {
    const rig = createHealRig({
      auditedThreads: Array.from({ length: 51 }, (_, index) => ({
        stamp: `2026-07-${String(index + 1).padStart(2, '0')}T10-00-00`,
        id: threadId(String(index + 1))
      }))
    })

    const summary = await runCodexSessionIndexHeal(rig.paths, {
      buildInvocation: rig.buildInvocation,
      readsPerServerSession: 1_000,
      readConcurrency: 1_000,
      interBatchDelayMs: 0
    })

    expect(summary).toMatchObject({ outcome: 'completed', healedThreads: 51 })
    expect(rig.readLog()).toMatchObject({ serverStarts: 2, maxInFlight: 2 })
  })

  it('stops promptly when shouldStop flips and resumes on the next pass', async () => {
    const rig = createHealRig({
      auditedThreads: Array.from({ length: 4 }, (_, index) => ({
        stamp: `2026-07-0${index + 1}T10-00-00`,
        id: threadId(String(index + 1))
      }))
    })
    let reads = 0
    const summary = await runCodexSessionIndexHeal(rig.paths, {
      buildInvocation: rig.buildInvocation,
      readsPerServerSession: 1,
      interBatchDelayMs: 0,
      shouldStop: () => reads++ >= 2
    })
    expect(summary.outcome).toBe('stopped')
    expect(summary.healedThreads).toBeLessThan(4)

    const resumed = await runCodexSessionIndexHeal(rig.paths, {
      buildInvocation: rig.buildInvocation,
      interBatchDelayMs: 0
    })
    expect(resumed.outcome).toBe('completed')
    expect(resumed.healedThreads + summary.healedThreads).toBe(4)
  })

  it('does not spawn another server when stop flips during the inter-batch delay', async () => {
    const rig = createHealRig({
      auditedThreads: [
        { stamp: '2026-07-02T10-00-00', id: threadId('2') },
        { stamp: '2026-07-01T10-00-00', id: threadId('1') }
      ]
    })
    let stopChecks = 0

    const summary = await runCodexSessionIndexHeal(rig.paths, {
      buildInvocation: rig.buildInvocation,
      readsPerServerSession: 1,
      interBatchDelayMs: 1,
      // False through the second batch's pre-delay check, then model opt-out
      // while the delay is in progress.
      shouldStop: () => stopChecks++ >= 3
    })

    expect(summary).toMatchObject({ outcome: 'stopped', healedThreads: 1 })
    expect(rig.readLog()).toMatchObject({ serverStarts: 1, threadIds: [threadId('2')] })
  })

  it('marks the pass unsupported without ledger writes when thread/read is unavailable', async () => {
    const rig = createHealRig({
      scenario: 'unknown-method',
      auditedThreads: [{ stamp: '2026-07-01T10-00-00', id: threadId('1') }]
    })

    const summary = await runCodexSessionIndexHeal(rig.paths, {
      buildInvocation: rig.buildInvocation,
      interBatchDelayMs: 0
    })
    expect(summary.outcome).toBe('unsupported')
    expect(summary.healedThreads).toBe(0)
    expect(readLedgerOutcomes(rig.paths)).toEqual({})

    // Within the retry interval the unsupported marker suppresses re-probing.
    const again = await runCodexSessionIndexHeal(rig.paths, {
      buildInvocation: rig.buildInvocation,
      interBatchDelayMs: 0
    })
    expect(again.outcome).toBe('up-to-date')
    expect(rig.readLog().serverStarts).toBe(1)

    const marker = JSON.parse(readFileSync(rig.paths.healMarkerPath, 'utf-8')) as {
      unsupportedAt: number
    }
    marker.unsupportedAt = 0
    writeFileSync(rig.paths.healMarkerPath, `${JSON.stringify(marker)}\n`, 'utf-8')
    const retried = await runCodexSessionIndexHeal(rig.paths, {
      buildInvocation: (home, timeoutMs) => {
        const invocation = rig.buildInvocation(home, timeoutMs)
        return {
          ...invocation,
          env: {
            STUB_CONFIG: JSON.stringify({
              scenario: 'ok',
              readLogFile: rig.readLogFile,
              missingThreadIds: [],
              failingThreadIds: []
            })
          }
        }
      },
      interBatchDelayMs: 0
    })
    expect(retried).toMatchObject({ outcome: 'completed', healedThreads: 1 })
  })

  it('marks the pass unsupported when the CLI lacks the app-server subcommand', async () => {
    const rig = createHealRig({
      scenario: 'no-subcommand',
      auditedThreads: [{ stamp: '2026-07-01T10-00-00', id: threadId('1') }]
    })
    const summary = await runCodexSessionIndexHeal(rig.paths, {
      buildInvocation: rig.buildInvocation,
      interBatchDelayMs: 0
    })
    expect(summary.outcome).toBe('unsupported')
  })

  it('aborts without recording when the server dies mid-batch, then retries next pass', async () => {
    const rig = createHealRig({
      scenario: 'die-mid-batch',
      auditedThreads: [
        { stamp: '2026-07-02T10-00-00', id: threadId('2') },
        { stamp: '2026-07-01T10-00-00', id: threadId('1') }
      ],
      dieOnThreadId: threadId('2')
    })

    const summary = await runCodexSessionIndexHeal(rig.paths, {
      buildInvocation: rig.buildInvocation,
      readConcurrency: 1,
      interBatchDelayMs: 0
    })
    expect(summary.outcome).toBe('aborted')
    expect(readLedgerOutcomes(rig.paths)[threadId('1')]).toBeUndefined()

    const retried = await runCodexSessionIndexHeal(rig.paths, {
      buildInvocation: (home, timeoutMs) => {
        const invocation = rig.buildInvocation(home, timeoutMs)
        return {
          ...invocation,
          env: {
            STUB_CONFIG: JSON.stringify({
              scenario: 'ok',
              readLogFile: rig.readLogFile,
              missingThreadIds: [],
              failingThreadIds: []
            })
          }
        }
      },
      interBatchDelayMs: 0
    })
    expect(retried.outcome).toBe('completed')
    expect(retried.healedThreads).toBe(2)
  })

  it('retries transient sqlite contention instead of marking the thread failed', async () => {
    const rig = createHealRig({
      auditedThreads: [{ stamp: '2026-07-01T10-00-00', id: threadId('1') }],
      busyThreadIds: [threadId('1')]
    })
    const summary = await runCodexSessionIndexHeal(rig.paths, {
      buildInvocation: rig.buildInvocation,
      interBatchDelayMs: 0
    })
    expect(summary.outcome).toBe('aborted')
    expect(readLedgerOutcomes(rig.paths)).toEqual({})

    const retried = await runCodexSessionIndexHeal(rig.paths, {
      buildInvocation: (home, timeoutMs) => {
        const invocation = rig.buildInvocation(home, timeoutMs)
        return {
          ...invocation,
          env: {
            STUB_CONFIG: JSON.stringify({
              scenario: 'ok',
              readLogFile: rig.readLogFile,
              missingThreadIds: [],
              failingThreadIds: [],
              busyThreadIds: []
            })
          }
        }
      },
      interBatchDelayMs: 0
    })
    expect(retried).toMatchObject({ outcome: 'completed', healedThreads: 1 })
  })

  it('completes immediately with no server spawn when there is nothing to heal', async () => {
    const rig = createHealRig({ auditedThreads: [] })
    const summary = await runCodexSessionIndexHeal(rig.paths, {
      buildInvocation: rig.buildInvocation,
      interBatchDelayMs: 0
    })
    expect(summary).toMatchObject({ outcome: 'completed', pendingThreads: 0 })
    expect(rig.readLog().serverStarts).toBe(0)
  })

  it('ignores audit records outside the backfill link/copy actions', async () => {
    const rig = createHealRig({ auditedThreads: [] })
    appendFileSync(
      rig.paths.auditLogPath,
      `${[
        JSON.stringify({ action: 'run-summary', scannedFiles: 3 }),
        JSON.stringify({ action: 'scan-failed', source: '/managed/sessions/2026' }),
        JSON.stringify({
          action: 'failed',
          target: rolloutTarget(rig.paths.systemSessionsRoot, '2026-07-01T10-00-00', threadId('9'))
        }),
        'not-json',
        ''
      ].join('\n')}\n`
    )
    const summary = await runCodexSessionIndexHeal(rig.paths, {
      buildInvocation: rig.buildInvocation,
      interBatchDelayMs: 0
    })
    expect(summary).toMatchObject({ outcome: 'completed', pendingThreads: 0 })
    expect(rig.readLog().serverStarts).toBe(0)
  })

  it('scopes audit and processed ledger records to the current Codex home', async () => {
    const currentId = threadId('1')
    const foreignId = threadId('2')
    const rig = createHealRig({
      auditedThreads: [{ stamp: '2026-07-01T10-00-00', id: currentId }]
    })
    const foreignRoot = `${rig.paths.systemSessionsRoot}-other`
    appendFileSync(
      rig.paths.auditLogPath,
      `${JSON.stringify({
        action: 'hardlink',
        target: rolloutTarget(foreignRoot, '2026-07-02T10-00-00', foreignId)
      })}\n`
    )
    appendFileSync(
      rig.paths.healLedgerPath,
      `${JSON.stringify({
        v: CODEX_SESSION_INDEX_HEAL_VERSION,
        systemSessionsRoot: foreignRoot,
        threadId: currentId,
        outcome: 'healed'
      })}\n`
    )

    const summary = await runCodexSessionIndexHeal(rig.paths, {
      buildInvocation: rig.buildInvocation,
      interBatchDelayMs: 0
    })

    expect(summary).toMatchObject({ outcome: 'completed', healedThreads: 1 })
    expect(rig.readLog().threadIds).toEqual([currentId])
  })

  it('does not mark the heal complete when the audit cannot be read', async () => {
    const rig = createHealRig({})
    rig.paths.auditLogPath = dirname(rig.paths.auditLogPath)

    await expect(
      runCodexSessionIndexHeal(rig.paths, {
        buildInvocation: rig.buildInvocation,
        interBatchDelayMs: 0
      })
    ).rejects.toBeInstanceOf(Error)

    expect(rig.readLog().serverStarts).toBe(0)
    expect(existsSync(rig.paths.healMarkerPath)).toBe(false)
  })

  it('does not mark the heal complete when a processed outcome cannot be persisted', async () => {
    const id = threadId('1')
    const rig = createHealRig({
      auditedThreads: [{ stamp: '2026-07-01T10-00-00', id }]
    })
    const healLedgerPath = rig.paths.healLedgerPath
    rig.paths.healLedgerPath = dirname(healLedgerPath)

    const failed = await runCodexSessionIndexHeal(rig.paths, {
      buildInvocation: rig.buildInvocation,
      interBatchDelayMs: 0
    })

    expect(failed.outcome).toBe('aborted')
    expect(existsSync(rig.paths.healMarkerPath)).toBe(false)

    rig.paths.healLedgerPath = healLedgerPath
    const retried = await runCodexSessionIndexHeal(rig.paths, {
      buildInvocation: rig.buildInvocation,
      interBatchDelayMs: 0
    })
    expect(retried).toMatchObject({ outcome: 'completed', healedThreads: 1 })
    expect(rig.readLog().threadIds).toEqual([id, id])
  })

  it('rebuilds a failed completion marker without repeating processed reads', async () => {
    const id = threadId('1')
    const rig = createHealRig({
      auditedThreads: [{ stamp: '2026-07-01T10-00-00', id }]
    })
    mkdirSync(rig.paths.healMarkerPath, { recursive: true })
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})

    const first = await runCodexSessionIndexHeal(rig.paths, {
      buildInvocation: rig.buildInvocation,
      interBatchDelayMs: 0
    })
    expect(first).toMatchObject({ outcome: 'completed', healedThreads: 1 })

    rmSync(rig.paths.healMarkerPath, { recursive: true })
    const resumed = await runCodexSessionIndexHeal(rig.paths, {
      buildInvocation: rig.buildInvocation,
      interBatchDelayMs: 0
    })
    expect(resumed).toMatchObject({ outcome: 'completed', pendingThreads: 0 })
    expect(rig.readLog().threadIds).toEqual([id])
    expect(JSON.parse(readFileSync(rig.paths.healMarkerPath, 'utf-8'))).toMatchObject({
      version: 3
    })
    expect(warnSpy).toHaveBeenCalled()
    warnSpy.mockRestore()
  })
})
