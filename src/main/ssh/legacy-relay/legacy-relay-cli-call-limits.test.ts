import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { toAppSshPtyId } from '../../../shared/ssh-pty-id'
import { isRemoteCliControlAllowed } from '../../../shared/ssh-remote-cli-control'
import { OrcaRuntimeService } from '../../runtime/orca-runtime'
import { OrchestrationDb } from '../../runtime/orchestration/db'
import {
  LEGACY_RELAY_CLI_BUSY,
  cappedWait,
  runLegacyRelayCliCall
} from './legacy-relay-cli-call-limits'
import { createLegacyRelayCliServer } from './legacy-relay-cli-server'

const TARGET = 'target-1'
const WORKER = 'term_relay_worker'
const WORKER_PANE = 'tab_w:33333333-3333-4333-8333-333333333333'
const COORDINATOR = 'term_local_coord'
const PTY_ID = toAppSshPtyId(TARGET, 'pty-7')
const ENV = { ORCA_TERMINAL_HANDLE: WORKER, ORCA_PANE_KEY: WORKER_PANE }

let dir: string
let db: OrchestrationDb
let runtime: OrcaRuntimeService
let allowed: boolean

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'orca-legacy-relay-limits-'))
  db = new OrchestrationDb(join(dir, 'orchestration.db'))
  runtime = new OrcaRuntimeService()
  runtime.setOrchestrationDb(db)
  vi.spyOn(runtime, 'notifyMessageArrived').mockImplementation(() => {})
  allowed = true
  const run = db.createRun({
    objective: 'retained work',
    coordinatorHandle: COORDINATOR,
    coordinatorPaneKey: 'tab_c:44444444-4444-4444-8444-444444444444'
  })
  const task = db.createTask({ runId: run.id, spec: 's', createdByTerminalHandle: COORDINATOR })
  db.createDispatchContext({
    taskId: task.id,
    assigneeHandle: WORKER,
    assigneePaneKey: WORKER_PANE,
    processIncarnation: `${PTY_ID}:inc-1`,
    creator: { kind: 'system' },
    maxDepth: Number.MAX_SAFE_INTEGER
  })
})

afterEach(() => {
  vi.useRealTimers()
  db.close()
  rmSync(dir, { recursive: true, force: true })
})

const server = () =>
  createLegacyRelayCliServer({
    targetId: TARGET,
    runtime: () => runtime,
    remoteCliControl: () => allowed,
    livePane: (paneKey) =>
      paneKey === WORKER_PANE
        ? { ptyId: PTY_ID, incarnationId: 'inc-1', terminalHandle: WORKER }
        : null
  })

describe('limits on relay-era CLI calls', () => {
  it('stops a waiting check once a default-on switch is turned off', async () => {
    allowed = isRemoteCliControlAllowed({})
    const waiting = server().cli(
      { argv: ['orchestration', 'check', '--wait', '--timeout-ms', '60000', '--json'], env: ENV },
      new AbortController().signal
    )
    await new Promise((resolve) => setTimeout(resolve, 50))
    allowed = isRemoteCliControlAllowed({ allowRemoteCliControl: false })
    const started = Date.now()
    const result = await waiting
    expect(Date.now() - started).toBeLessThan(5_000)
    const stdout = result && typeof result === 'object' && 'stdout' in result ? result.stdout : ''
    expect(JSON.parse(String(stdout)).result).toMatchObject({ cancelled: true })
  })

  it('caps how many calls one host may hold open', async () => {
    const release: (() => void)[] = []
    const held = Array.from({ length: 16 }, () =>
      runLegacyRelayCliCall(
        TARGET,
        () => true,
        new AbortController().signal,
        () => new Promise<void>((resolve) => release.push(resolve))
      )
    )
    await expect(
      runLegacyRelayCliCall(
        TARGET,
        () => true,
        new AbortController().signal,
        async () => {}
      )
    ).rejects.toThrow(LEGACY_RELAY_CLI_BUSY)
    // Another host is unaffected.
    await expect(
      runLegacyRelayCliCall(
        'other-target',
        () => true,
        new AbortController().signal,
        async () => 1
      )
    ).resolves.toBe(1)
    release.forEach((resolve) => resolve())
    await Promise.all(held)
    await expect(
      runLegacyRelayCliCall(
        TARGET,
        () => true,
        new AbortController().signal,
        async () => 2
      )
    ).resolves.toBe(2)
  })

  it('caps how long a host may park a desktop waiter', () => {
    expect(cappedWait(Number.MAX_SAFE_INTEGER)).toBe(1_800_000)
    expect(cappedWait(-5)).toBe(0)
    expect(cappedWait(undefined)).toBeUndefined()
  })

  it('scopes a reused retry id whose payload differs from the committed one', async () => {
    const retry = ['--retry-request', '66666666-6666-4666-8666-666666666666']
    await server().cli(
      {
        argv: ['orchestration', 'send', '--to', COORDINATOR, '--subject', 'a', ...retry],
        env: ENV
      },
      new AbortController().signal
    )
    await expect(
      server().cli(
        {
          argv: ['orchestration', 'send', '--to', 'term_unrelated', '--subject', 'a', ...retry],
          env: ENV
        },
        new AbortController().signal
      )
    ).rejects.toThrow(/outside it/)
  })

  it('replays a committed reply after the worker took a new assignment', async () => {
    const dispatch = db.getActiveDispatchForIdentity(WORKER, WORKER_PANE)
    const question = db.insertMessage({
      runId: dispatch?.run_id ?? '',
      from: COORDINATOR,
      to: `dispatch:${dispatch?.id ?? ''}`,
      subject: 'q',
      deliveryContract: 'current_delivery'
    })
    const reply = [
      'orchestration',
      'reply',
      '--id',
      question.id,
      '--body',
      'b',
      '--retry-request',
      '99999999-9999-4999-8999-999999999999',
      '--json'
    ]
    const first = await server().cli({ argv: reply, env: ENV }, new AbortController().signal)
    db.db.prepare(`UPDATE dispatch_contexts SET status = 'completed'`).run()
    const next = db.createTask({
      runId: dispatch?.run_id ?? '',
      spec: 'next',
      createdByTerminalHandle: COORDINATOR
    })
    db.createDispatchContext({
      taskId: next.id,
      assigneeHandle: WORKER,
      assigneePaneKey: WORKER_PANE,
      processIncarnation: `${PTY_ID}:inc-1`,
      creator: { kind: 'system' },
      maxDepth: Number.MAX_SAFE_INTEGER
    })
    const replay = await server().cli({ argv: reply, env: ENV }, new AbortController().signal)
    const body = (result: unknown) =>
      JSON.parse(
        String(result && typeof result === 'object' && 'stdout' in result ? result.stdout : '')
      )
    expect(body(replay)).toMatchObject({ ok: true, result: { mutation: { replayed: true } } })
    expect(body(replay).result.message).toEqual(body(first).result.message)
  })

  it('bounds the rows an inbox read may return', async () => {
    const read = vi.spyOn(db, 'getAllMessagesForHandle')
    for (const limit of ['-1', '1000000000', '0']) {
      await server().cli(
        { argv: ['orchestration', 'inbox', '--limit', limit, '--json'], env: ENV },
        new AbortController().signal
      )
    }
    expect(read.mock.calls.map((call) => call[1])).toEqual([1, 100, 1])
  })

  it('names nobody when two hosts claim one handle', () => {
    const terminal = { handle: WORKER, paneKey: WORKER_PANE, processIncarnation: 'p-1' }
    const fresh = new OrcaRuntimeService()
    const a = fresh.registerOrchestrationCompatibilitySshAttachment('host-a', 'c-1', terminal)
    expect(fresh.getTerminalPaneKey(WORKER)).toBe(WORKER_PANE)
    const b = fresh.registerOrchestrationCompatibilitySshAttachment('host-b', 'c-2', terminal)
    expect(fresh.getTerminalPaneKey(WORKER)).toBeNull()
    expect(fresh.getTerminalProcessIncarnation(WORKER)).toBeNull()
    fresh.releaseOrchestrationCompatibilitySshAttachment(b.attachmentId)
    expect(fresh.getTerminalProcessIncarnation(WORKER)).toBe('p-1')
    fresh.releaseOrchestrationCompatibilitySshAttachment(a.attachmentId)
  })
})
