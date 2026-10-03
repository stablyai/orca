// The host's own startup step, run from `prepare` whether or not any client ever lists a tab: a
// headless host has its seeded statuses and its settled crashed chats, and no failure in the step
// (one chat's open, one chat's settlement) costs startup or the other chats.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  closeTestJournalHostDatabases,
  readTestJournalSessionStatus
} from '../native-chat/agent-session-journal/journal-host-database-test-support'
import { isUnsettledJournalSessionStatus } from '../native-chat/agent-session-journal/journal-session-state'
import { AgentSessionJournal } from '../native-chat/agent-session-journal/journal-store'
import { setStructuredAgentSessionHost } from '../native-chat/agent-session-wire/structured-agent-session-registry'
import {
  createRestTestRig,
  restTestChat,
  type RestTestRig
} from '../native-chat/agent-session-wire/structured-agent-session-rest-test-rig'
import {
  latestRestTestStatus,
  restTestOpens
} from '../native-chat/agent-session-wire/structured-agent-session-rest-test-observations'
import { OrcaRuntimeService } from './orca-runtime'
import { StructuredAgentSessionStartupGate } from './structured-agent-session-startup-gate'
import type { StructuredAgentSessionLogger } from '../native-chat/agent-session-wire/structured-agent-session-logger'

type PrepareInternals = {
  structuredAgentSessionStartupGate: StructuredAgentSessionStartupGate
  structuredAgentSessionStartupLogger: StructuredAgentSessionLogger
  store: { getWorkspaceSession: () => unknown }
  hasPersistedStructuredAgentSessionStore(): boolean
  refreshMobileSessionPtyRecords(): Promise<Set<string> | null>
  ensureStructuredAgentSessionHost(): Promise<void>
}

let rig: RestTestRig

beforeEach(async () => {
  rig = await createRestTestRig()
})

afterEach(async () => {
  setStructuredAgentSessionHost(null)
  await rig.dispose()
  closeTestJournalHostDatabases()
  vi.restoreAllMocks()
})

function internals(runtime: OrcaRuntimeService): PrepareInternals {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: these members exist on the runtime; they are protected, not absent.
  return runtime as unknown as PrepareInternals
}

/** A restarted runtime over the rig's host, with nothing but `prepare` ever called on it. */
function restartedRuntime(): OrcaRuntimeService {
  const runtime = new OrcaRuntimeService()
  const internal = internals(runtime)
  internal.store = { getWorkspaceSession: () => null }
  internal.hasPersistedStructuredAgentSessionStore = () => true
  internal.refreshMobileSessionPtyRecords = async () => new Set()
  internal.ensureStructuredAgentSessionHost = async () => {
    setStructuredAgentSessionHost(rig.host)
  }
  return runtime
}

async function crashMidSend(sessionId: string, listed = true): Promise<void> {
  rig.adapter.dispatch.mockResolvedValueOnce({ state: 'admitted' })
  await restTestChat(rig, sessionId, { message: `asked ${sessionId}`, listed })
}

function owes(sessionId: string): boolean | undefined {
  const stored = readTestJournalSessionStatus(rig.root, sessionId)
  return stored ? isUnsettledJournalSessionStatus(stored) : undefined
}

it('holds chat commands until the startup settle ends, and then lets them through', async () => {
  await crashMidSend('session-crashed')
  await rig.crash()
  await rig.boot()
  const runtime = restartedRuntime()
  const gate = internals(runtime).structuredAgentSessionStartupGate
  const timing = vi.spyOn(console, 'info').mockImplementation(() => undefined)
  runtime.holdStructuredAgentSessionCommandsForStartup()
  expect(gate.ready()).not.toBeNull()

  await runtime.prepareStructuredAgentSessionStartupRestoration()
  await vi.waitFor(() => expect(owes('session-crashed')).toBe(false))

  await vi.waitFor(() => expect(gate.ready()).toBeNull())
  expect(timing).toHaveBeenCalledWith(
    expect.stringMatching(
      /step started \+\d+ ms, ended \+\d+ ms \(settle ended\); opened \+\d+ ms by settle ended$/
    )
  )
})

it('opens the gate when the startup step fails, never stranding a command', async () => {
  await rig.crash()
  await rig.boot()
  const runtime = restartedRuntime()
  const gate = internals(runtime).structuredAgentSessionStartupGate
  internals(runtime).ensureStructuredAgentSessionHost = async () => {
    throw new Error('host refused')
  }
  vi.spyOn(console, 'warn').mockImplementation(() => undefined)
  runtime.holdStructuredAgentSessionCommandsForStartup()

  const timing = vi.spyOn(console, 'info').mockImplementation(() => undefined)
  await runtime.prepareStructuredAgentSessionStartupRestoration().catch(() => undefined)

  expect(gate.ready()).toBeNull()
  expect(timing).toHaveBeenCalledOnce()
  expect(timing).toHaveBeenCalledWith(
    expect.stringMatching(/\(step failed\); opened \+\d+ ms by step failed$/)
  )
})

it('lets held commands go before the shortest client timeout on a held call (the AI vault restore, 5 s)', () => {
  vi.spyOn(console, 'warn').mockImplementation(() => undefined)
  vi.useFakeTimers()
  try {
    const gate = new StructuredAgentSessionStartupGate()
    gate.hold()
    vi.advanceTimersByTime(4_500)
    expect(gate.ready()).toBeNull()
  } finally {
    vi.useRealTimers()
  }
})

it('reports a failed startup step to the diagnostics logger, not only the console', async () => {
  vi.spyOn(console, 'warn').mockImplementation(() => undefined)
  vi.spyOn(console, 'info').mockImplementation(() => undefined)
  const runtime = restartedRuntime()
  const internal = internals(runtime)
  const failure = new Error('host build failed')
  internal.ensureStructuredAgentSessionHost = async () => {
    throw failure
  }
  const warn = vi.spyOn(internal.structuredAgentSessionStartupLogger, 'warn')

  runtime.startStructuredAgentSessionStartupAfter(Promise.resolve())

  await vi.waitFor(() =>
    expect(warn).toHaveBeenCalledWith('the chat startup step failed', {
      scope: 'startup-step-failed',
      error: failure
    })
  )
})

it('closes the gate once per launch: a hold after it opened leaves it open', async () => {
  const gate = new StructuredAgentSessionStartupGate()
  gate.hold()
  gate.hold()
  vi.spyOn(console, 'info').mockImplementation(() => undefined)
  gate.stepStarted()
  gate.stepEnded('no chats on disk')
  expect(gate.ready()).toBeNull()

  gate.hold()

  expect(gate.ready()).toBeNull()
})

describe('one timing line per launch, with the real step times whoever opened the gate', () => {
  const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
  const CEILING_MS = 5
  let timing: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    timing = vi.spyOn(console, 'info').mockImplementation(() => undefined)
  })

  /** Exactly one line, for a gate the ceiling opened before the step ended `outcome`. */
  async function expectOneCeilingLine(outcome: string, started = /\+\d+ ms/): Promise<void> {
    await vi.waitFor(() => expect(timing).toHaveBeenCalledOnce())
    await sleep(20)
    expect(timing).toHaveBeenCalledOnce()
    const line = String(timing.mock.calls[0]?.[0])
    expect(line).toMatch(
      new RegExp(`ended \\+\\d+ ms \\(${outcome}\\); opened \\+\\d+ ms by ceiling$`)
    )
    expect(line).toMatch(new RegExp(`step started ${started.source},`))
  }

  it.each(['settle ended', 'no host', 'step failed'] as const)(
    'writes it when the step ends after the ceiling: %s',
    async (outcome) => {
      const gate = new StructuredAgentSessionStartupGate(CEILING_MS)
      gate.hold()
      gate.stepStarted()
      await vi.waitFor(() => expect(gate.ready()).toBeNull())
      expect(timing).not.toHaveBeenCalled()

      gate.stepEnded(outcome)

      await expectOneCeilingLine(outcome)
    }
  )

  it('times a step that starts only after the ceiling', async () => {
    const gate = new StructuredAgentSessionStartupGate(CEILING_MS)
    gate.hold()
    await vi.waitFor(() => expect(gate.ready()).toBeNull())
    await sleep(10)
    expect(timing).not.toHaveBeenCalled()

    gate.stepStarted()
    gate.openWhen(Promise.resolve())

    await expectOneCeilingLine('settle ended', /\+([5-9]|\d{2,}) ms/)
  })

  it.each([
    ['throws', 'step failed'],
    ['builds no host', 'no host']
  ] as const)('writes it when a slow host build past the ceiling %s', async (how, outcome) => {
    const runtime = restartedRuntime()
    const internal = internals(runtime)
    internal.structuredAgentSessionStartupGate = new StructuredAgentSessionStartupGate(CEILING_MS)
    internal.ensureStructuredAgentSessionHost = async () => {
      await sleep(30)
      if (how === 'throws') {
        throw new Error('host build failed')
      }
    }
    runtime.holdStructuredAgentSessionCommandsForStartup()

    await runtime.prepareStructuredAgentSessionStartupRestoration().catch(() => undefined)

    await expectOneCeilingLine(outcome)
  })
})

it('seeds and settles on a host no client ever lists (T8)', async () => {
  await restTestChat(rig, 'session-settled', { message: 'done' })
  await crashMidSend('session-crashed')
  await crashMidSend('session-crashed-closed', false)
  await rig.crash()
  await rig.boot()
  const runtime = restartedRuntime()

  await runtime.prepareStructuredAgentSessionStartupRestoration()

  expect(latestRestTestStatus(rig, 'session-settled')).toMatchObject({ status: 'idle' })
  await vi.waitFor(() => {
    expect(owes('session-crashed')).toBe(false)
    expect(owes('session-crashed-closed')).toBe(false)
  })
  expect(rig.host.hasSession('session-crashed')).toBe(true)
  expect(rig.host.hasSession('session-crashed-closed')).toBe(false)
  expect(restTestOpens(rig, 'session-settled')).toBe(0)
})

it('never fails startup: each failure is logged by chat and the rest still settle (T18)', async () => {
  await restTestChat(rig, 'session-settled', { message: 'done' })
  for (const sessionId of ['session-open-fails', 'session-settle-fails', 'session-fine']) {
    await crashMidSend(sessionId)
  }
  await rig.crash()
  await rig.boot()
  const warn = vi.spyOn(rig.host.deps.logger, 'warn')
  rig.adapter.historyFilePath.mockImplementation(async (sessionId) => {
    if (sessionId === 'session-open-fails') {
      throw new Error('EACCES: permission denied')
    }
    return null
  })
  const markUnknown = AgentSessionJournal.prototype.markPendingSubmissionsUnknown
  vi.spyOn(AgentSessionJournal.prototype, 'markPendingSubmissionsUnknown').mockImplementation(
    function (this: AgentSessionJournal, ...args) {
      if (this.snapshot().sessionId === 'session-settle-fails') {
        return Promise.reject(new Error('settlement append failed'))
      }
      return markUnknown.apply(this, args)
    }
  )
  const runtime = restartedRuntime()

  await runtime.prepareStructuredAgentSessionStartupRestoration()

  expect(latestRestTestStatus(rig, 'session-settled')).toMatchObject({ status: 'idle' })
  await vi.waitFor(() => expect(owes('session-fine')).toBe(false))
  expect(owes('session-open-fails')).toBe(true)
  expect(owes('session-settle-fails')).toBe(true)
  expect(warn).toHaveBeenCalledWith(
    'restoring a chat for reading failed',
    expect.objectContaining({ sessionId: 'session-open-fails' })
  )
})
