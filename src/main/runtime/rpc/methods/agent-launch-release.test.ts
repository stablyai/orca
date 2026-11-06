import { closeTestJournalHostDatabases } from '../../../native-chat/agent-session-journal/journal-host-database-test-support'
import '../unused-default-rpc-methods.test-fixture'
/** A desktop new-workspace chat prepared before its workspace's required Setup and released with the
 * first turn's final choices: the host still owns Setup, the surface and every effect, and starts
 * nothing until the caller's own live launch is handed one immutable input. */

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createSetupRun, type SetupRun } from '../../setup/setup-run'
import type * as StructuredCreate from './structured-agent-session-create'
import type * as CloseBeforeCreate from './structured-agent-session-close-before-create'
import type { AgentSessionRecordStore } from '../../agent-session/records/agent-session-record-store'
import { openTestAgentSessionRecordStore } from '../../agent-session/records/agent-session-record-store-test-harness'
import type { RpcContext } from '../core'
import { DESKTOP_RPC_CALLER } from '../rpc-caller-identity'
import { DESKTOP_RENDERER_RUNTIME_CLIENT_CAPABILITIES } from '../../../ipc/desktop-renderer-runtime-capabilities'
import { deriveAgentLaunchChildOperationId } from '../../../../shared/agent-launch/contracts/agent-launch-operation'
import { resolveAgentStartupPlanInputs } from '../../../../shared/agent-launch/startup/agent-startup-plan-inputs'
import { planLaunchAgentStartupPrompt } from '../../../../shared/agent-launch/startup/launch-agent-startup-prompt-plan'
import {
  backgroundTerminalStartup,
  compileAgentLaunchTerminalAlternative,
  foregroundTerminalStartup,
  planQuickAgentStartup
} from '../../../../shared/agent-launch/startup/agent-launch-terminal-recipe'
import { tokenizeStartupCommand } from '../../../../shared/agent-launch/startup/tui-agent-startup-shell'
import {
  CAPABLE_CLIENT,
  methodNamed,
  rpcContext,
  runtimeStub,
  setAgentLaunchRecordStore,
  type AgentLaunchRuntimeStubOptions,
  emitWorktreeRemovedForTests
} from './agent-launch.test-fixture'

const createStructured = vi.hoisted(() =>
  vi.fn(
    async (args: {
      envelope: { sessionId: string }
      firstMessage?: { clientMessageId: string }
    }): Promise<unknown> => ({
      ok: true as const,
      value: {
        sessionId: args.envelope.sessionId,
        fence: 1,
        ...(args.firstMessage ? { firstMessage: args.firstMessage } : {})
      }
    })
  )
)
vi.mock('./structured-agent-session-create', () => ({
  createStructuredAgentSessionForWorktree: createStructured
}))
// Counts the launch's live close subscriptions, the one resource a launch holds outside its own map.
const closeSubscriptions = vi.hoisted(() => ({ live: 0 }))
vi.mock('./structured-agent-session-close-before-create', async (importOriginal) => {
  const actual = await importOriginal<typeof CloseBeforeCreate>()
  return {
    ...actual,
    subscribeStructuredAgentSessionClose: (sessionId: string, listener: () => void) => {
      const unsubscribe = actual.subscribeStructuredAgentSessionClose(sessionId, listener)
      closeSubscriptions.live += 1
      let live = true
      return () => {
        if (live) {
          live = false
          closeSubscriptions.live -= 1
        }
        unsubscribe()
      }
    }
  }
})

const { AGENT_LAUNCH_ACCEPT_METHODS } = await import('./agent-launch-accept')
const { AGENT_LAUNCH_RELEASE_METHODS } = await import('./agent-launch-release')
const { activeAgentLaunchesFor } = await import('./agent-launch-in-flight')
const { noteStructuredAgentSessionClose, resetStructuredAgentSessionClosesBeforeCreateForTests } =
  await import('./structured-agent-session-close-before-create')
const ACCEPT = methodNamed(AGENT_LAUNCH_ACCEPT_METHODS, 'agent.launchAccept')
const STATUS = methodNamed(AGENT_LAUNCH_ACCEPT_METHODS, 'agent.launchStatus')
const PREPARE = methodNamed(AGENT_LAUNCH_RELEASE_METHODS, 'agent.launchPrepare')
const RELEASE = methodNamed(AGENT_LAUNCH_RELEASE_METHODS, 'agent.launchRelease')

const SESSION_ID = 'claude_9b1deb4d_3b7d_4bad_9bdd_2b0d7b3dcb6d'
const MESSAGE_ID = 'message-3f2504e0'
const HELD_MESSAGE = 'fix the failing test'
const DESKTOP: Partial<RpcContext> = {
  clientId: 'desktop-renderer',
  caller: DESKTOP_RPC_CALLER,
  clientKind: 'runtime',
  clientCapabilities: DESKTOP_RENDERER_RUNTIME_CLIENT_CAPABILITIES
}
const DESKTOP_KEY = 'trusted-local:desktop'
const PICKED = {
  options: { permissionMode: 'ask', model: 'opus', effort: 'high' },
  optionsMode: 'replace-model-selection',
  selection: { model: 'opus', effort: 'high' }
} as const

let directory: string
let store: AgentSessionRecordStore
const runs: SetupRun[] = []

function operationId(index = 0): string {
  return `${Date.now()}-${index.toString(16).padStart(32, '0')}`
}

function prepared(id: string, overrides: Record<string, unknown> = {}) {
  return {
    agent: 'claude',
    operationId: id,
    target: { kind: 'existing', worktree: 'id:wt-7' },
    sessionId: SESSION_ID,
    nativeChatDefault: true,
    prompt: { text: HELD_MESSAGE, delivery: 'submit', clientMessageId: MESSAGE_ID },
    terminalAlternative: { kind: 'agent', prompt: 'submit' },
    setupReceipt: { required: false },
    ...overrides
  }
}

function hostRuntime(run?: SetupRun, options: AgentLaunchRuntimeStubOptions = {}) {
  return Object.assign(runtimeStub(options), {
    getSetupRun: vi.fn((_worktreeId: string) => run),
    pasteStartupDraftWhenReady: vi.fn((_handle: string, _draft: unknown) => {}),
    deliverStartupFollowup: vi.fn(async (_handle: string, _followup: unknown) => true),
    selectCreatedMobileSessionTabForClient: vi.fn(() => true)
  })
}
type HostRuntime = ReturnType<typeof hostRuntime>

function prepare(runtime: HostRuntime, params: unknown) {
  return PREPARE.handler(PREPARE.params.parse(params), rpcContext(runtime, DESKTOP))
}

function release(
  runtime: HostRuntime,
  id: string,
  input: Record<string, unknown> = PICKED,
  caller: Partial<RpcContext> = DESKTOP
) {
  return RELEASE.handler(
    RELEASE.params.parse({ operationId: id, ...input }),
    rpcContext(runtime, caller)
  )
}

function status(runtime: HostRuntime, id: string, read: Record<string, unknown> = {}) {
  return STATUS.handler(
    STATUS.params.parse({ operationId: id, ...read }),
    rpcContext(runtime, DESKTOP)
  )
}

/** Reads as the releasing caller does until the launch says it waits for its input. */
async function untilAwaitingRelease(runtime: HostRuntime, id: string): Promise<void> {
  for (let read = 0; read < 100; read += 1) {
    const answer = await status(runtime, id, { includeReleasePhase: true })
    if (answer.state === 'awaiting-release') {
      return
    }
    await new Promise((resolve) => setImmediate(resolve))
  }
  throw new Error('the prepared launch never became ready for its input')
}

function noEffect(runtime: HostRuntime): void {
  expect(createStructured).not.toHaveBeenCalled()
  expect(runtime.createTerminal).not.toHaveBeenCalled()
}

beforeEach(async () => {
  createStructured.mockClear()
  resetStructuredAgentSessionClosesBeforeCreateForTests()
  directory = await mkdtemp(join(tmpdir(), 'orca-agent-launch-release-'))
  store = await openTestAgentSessionRecordStore(directory)
  setAgentLaunchRecordStore(store)
})

afterEach(async () => {
  vi.useRealTimers()
  for (const run of runs.splice(0)) {
    run.settle({ kind: 'ended', reason: 'closed' })
  }
  setAgentLaunchRecordStore(null)
  await closeTestJournalHostDatabases()
  await rm(directory, { recursive: true, force: true })
})

describe('a launch prepared while its workspace runs required Setup', () => {
  it('waits for the exact Setup, then for its input, and only then founds the chat with those choices', async () => {
    const run = createSetupRun(true)
    runs.push(run)
    const runtime = hostRuntime(run)
    const id = operationId()
    await expect(
      prepare(runtime, prepared(id, { setupReceipt: { required: true, runId: run.id } }))
    ).resolves.toEqual({ operationId: id, state: 'running' })
    await expect(status(runtime, id, { includeReleasePhase: true, waitMs: 20 })).resolves.toEqual({
      state: 'running'
    })

    run.settle({ kind: 'succeeded' })
    await expect(
      status(runtime, id, { includeReleasePhase: true, waitMs: 5_000 })
    ).resolves.toEqual({ state: 'awaiting-release' })
    // A reader that never asked for the phase still sees the launch running, as before.
    await expect(status(runtime, id)).resolves.toEqual({ state: 'running' })
    noEffect(runtime)

    await expect(release(runtime, id)).resolves.toEqual({ operationId: id, state: 'running' })
    await expect(status(runtime, id, { waitMs: 5_000 })).resolves.toMatchObject({
      state: 'succeeded',
      result: { prompt: { delivery: 'submit', outcome: 'journaled', messageId: MESSAGE_ID } }
    })
    expect(createStructured).toHaveBeenCalledOnce()
    expect(createStructured.mock.calls[0]?.[0]).toMatchObject({
      options: PICKED.options,
      optionsMode: 'replace-model-selection',
      firstMessage: { clientMessageId: MESSAGE_ID, selection: PICKED.selection }
    })
  })

  it.each([
    {
      picked: 'new choices',
      input: {
        options: { model: 'gpt-5.5', effort: 'high' },
        optionsMode: 'replace-model-selection',
        selection: { model: 'gpt-5.5', effort: 'high' }
      },
      firstTurn: { model: 'gpt-5.5', effort: 'high' }
    },
    // Empty is still explicit: the chat's remembered model never runs the first turn.
    { picked: 'an empty selection', input: { options: {}, selection: {} }, firstTurn: {} }
  ])('runs the first turn on $picked through the real chat host', async ({ input, firstTurn }) => {
    const { createRestTestRig } =
      await import('../../../native-chat/agent-session-wire/structured-agent-session-rest-test-rig')
    const { setStructuredAgentSessionHost } =
      await import('../../../native-chat/agent-session-wire/structured-agent-session-registry')
    const actual = await vi.importActual<typeof StructuredCreate>(
      './structured-agent-session-create'
    )
    const rig = await createRestTestRig({ idleSweep: { intervalMs: 60_000 } })
    rig.clock.now = Date.now()
    setStructuredAgentSessionHost(rig.host)
    const sessionId = 'codex_9b1deb4d_3b7d_4bad_9bdd_2b0d7b3dcb6d'
    const runtime = Object.assign(hostRuntime(), {
      resolveStructuredAgentSessionCreateIntent: vi.fn(async (args: { envelope: unknown }) => ({
        envelope: args.envelope,
        location: {
          executionHostId: 'local',
          wslDistro: null,
          workspaceId: 'wt-7',
          workspaceKind: 'git-worktree'
        },
        provider: 'codex',
        agent: 'codex',
        accountHome: { variable: 'CODEX_HOME', path: '/host/.codex' },
        options: { model: 'gpt-5.6-sol', effort: 'medium' },
        runtimeKind: 'native'
      })),
      publishStructuredAgentSessionTab: vi.fn(async () => {})
    })
    createStructured.mockImplementationOnce(
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the launch hands the real create its real arguments; the mock's narrow type covers only the stubbed cases.
      actual.createStructuredAgentSessionForWorktree as unknown as Parameters<
        typeof createStructured.mockImplementationOnce
      >[0]
    )
    try {
      const id = operationId()
      await prepare(runtime, prepared(id, { agent: 'codex', sessionId }))
      await untilAwaitingRelease(runtime, id)
      expect(rig.adapter.acquire).not.toHaveBeenCalled()
      expect(rig.store.getRecord(sessionId)).toBeNull()
      await release(runtime, id, input)
      await vi.waitFor(() => expect(rig.adapter.dispatch).toHaveBeenCalledOnce())
      const dispatched = rig.adapter.dispatch.mock.calls[0]?.[0]
      expect(dispatched?.clientMessageId).toBe(MESSAGE_ID)
      const { model, effort } = dispatched?.executionOptions ?? {}
      expect({ ...(model ? { model } : {}), ...(effort ? { effort } : {}) }).toEqual(firstTurn)
    } finally {
      setStructuredAgentSessionHost(null)
      await rig.dispose()
    }
  })
})

describe('only the caller’s own live prepared launch takes an input', () => {
  it('joins an identical release and refuses a different one, with one input record', async () => {
    const runtime = hostRuntime()
    const id = operationId()
    await prepare(runtime, prepared(id))
    await untilAwaitingRelease(runtime, id)
    const changed = { ...PICKED, selection: { model: 'sonnet' } }
    const [first, second, conflicting] = await Promise.allSettled([
      release(runtime, id),
      release(runtime, id),
      release(runtime, id, changed)
    ])
    expect(first).toEqual({ status: 'fulfilled', value: { operationId: id, state: 'running' } })
    expect(second).toEqual(first)
    expect(conflicting).toMatchObject({
      status: 'rejected',
      reason: { message: 'agent_session_operation_conflict' }
    })
    await expect(status(runtime, id, { waitMs: 5_000 })).resolves.toMatchObject({
      state: 'succeeded'
    })
    expect(createStructured).toHaveBeenCalledOnce()
    const child = store.getOperationRow(
      DESKTOP_KEY,
      deriveAgentLaunchChildOperationId(id, 'release') ?? ''
    )
    expect(child?.outcome).toEqual({ status: 'succeeded', sessionId: '' })
  })

  it('answers a release whose reply was lost with the launch’s own outcome, never a second effect', async () => {
    const runtime = hostRuntime()
    const id = operationId()
    await prepare(runtime, prepared(id))
    await untilAwaitingRelease(runtime, id)
    await release(runtime, id)
    const settled = await status(runtime, id, { waitMs: 5_000 })
    expect(settled).toMatchObject({ state: 'succeeded' })

    await expect(release(runtime, id)).resolves.toEqual({ operationId: id, ...settled })
    await expect(release(runtime, id, { ...PICKED, selection: {} })).rejects.toThrow(
      'agent_session_operation_conflict'
    )
    expect(createStructured).toHaveBeenCalledOnce()
    expect(createStructured.mock.calls[0]?.[0].firstMessage?.clientMessageId).toBe(MESSAGE_ID)
  })

  it('installs nothing for another caller, an accepted launch or an id never prepared', async () => {
    const run = createSetupRun(true)
    runs.push(run)
    const runtime = hostRuntime(run)
    const id = operationId(1)
    await prepare(runtime, prepared(id))
    await untilAwaitingRelease(runtime, id)
    // Another caller has no launch under the id, and gains no input record either.
    await expect(release(runtime, id, PICKED, CAPABLE_CLIENT)).resolves.toEqual({
      operationId: id,
      state: 'absent'
    })
    await expect(release(runtime, operationId(2))).resolves.toMatchObject({ state: 'absent' })
    const accepted = operationId(3)
    await ACCEPT.handler(
      ACCEPT.params.parse({
        ...prepared(accepted),
        terminalAlternative: undefined,
        setupReceipt: { required: true, runId: run.id }
      }),
      rpcContext(runtime, DESKTOP)
    )
    await expect(release(runtime, accepted)).rejects.toThrow('agent_session_operation_conflict')
    await expect(status(runtime, id, { includeReleasePhase: true })).resolves.toEqual({
      state: 'awaiting-release'
    })
    noEffect(runtime)
  })

  it('stays unknown after a host restart even though its input was acknowledged', async () => {
    const runtime = hostRuntime()
    const id = operationId()
    createStructured.mockImplementationOnce(() => new Promise(() => {}))
    await prepare(runtime, prepared(id))
    await untilAwaitingRelease(runtime, id)
    await release(runtime, id)
    await vi.waitFor(() => expect(createStructured).toHaveBeenCalledOnce())

    store = await openTestAgentSessionRecordStore(directory)
    setAgentLaunchRecordStore(store)
    const restarted = hostRuntime()
    expect(
      store.getOperationRow(DESKTOP_KEY, deriveAgentLaunchChildOperationId(id, 'release') ?? '')
        ?.outcome
    ).toEqual({ status: 'succeeded', sessionId: '' })
    await expect(status(restarted, id, { includeReleasePhase: true })).resolves.toEqual({
      state: 'unknown'
    })
    await expect(release(restarted, id)).resolves.toEqual({ operationId: id, state: 'unknown' })
    await expect(prepare(restarted, prepared(id))).resolves.toMatchObject({ state: 'unknown' })
    expect(createStructured).toHaveBeenCalledOnce()
    expect(restarted.createTerminal).not.toHaveBeenCalled()
    expect(restarted.getStructuredAgentSessionCreateSupport).not.toHaveBeenCalled()
  })

  it('starts nothing once its chat is closed while it waits, and leaves nothing behind', async () => {
    const runtime = hostRuntime()
    const id = operationId()
    const subscribed = closeSubscriptions.live
    await prepare(runtime, prepared(id))
    await untilAwaitingRelease(runtime, id)
    expect(closeSubscriptions.live).toBe(subscribed + 1)
    noteStructuredAgentSessionClose(SESSION_ID, false)
    await expect(status(runtime, id, { waitMs: 5_000 })).resolves.toEqual({
      state: 'failed',
      code: 'agent_launch_tab_closed'
    })
    await expect(release(runtime, id)).resolves.toMatchObject({ code: 'agent_launch_tab_closed' })
    expect(activeAgentLaunchesFor(rpcContext(runtime, DESKTOP).runtime).size).toBe(0)
    expect(closeSubscriptions.live).toBe(subscribed)
    noEffect(runtime)
  })
  it('starts nothing once its workspace is removed while it waits', async () => {
    const runtime = hostRuntime()
    const id = operationId()
    await prepare(runtime, prepared(id))
    await untilAwaitingRelease(runtime, id)
    const { worktree } = (prepared(id) as { target: { worktree: string } }).target
    emitWorktreeRemovedForTests(worktree.replace(/^id:/, ''))
    await expect(status(runtime, id, { waitMs: 5_000 })).resolves.toMatchObject({
      state: 'failed'
    })
    expect(activeAgentLaunchesFor(rpcContext(runtime, DESKTOP).runtime).size).toBe(0)
    noEffect(runtime)
  })
})

describe('a prepared launch whose input never arrives', () => {
  const DAY = 25 * 60 * 60 * 1000

  it.each([3, 30])(
    'ends all %i at its own horizon with no effect, and holds nothing afterwards',
    async (count) => {
      vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] })
      const runtime = hostRuntime()
      const subscribed = closeSubscriptions.live
      const ids = Array.from({ length: count }, (_, index) => operationId(index + 1))
      for (const [index, id] of ids.entries()) {
        const sessionId = `claude_9b1deb4d_3b7d_4bad_9bdd_${index.toString().padStart(12, '0')}`
        await prepare(runtime, prepared(id, { sessionId }))
      }
      for (const id of ids) {
        await untilAwaitingRelease(runtime, id)
      }
      const active = activeAgentLaunchesFor(rpcContext(runtime, DESKTOP).runtime)
      expect(active.size).toBe(count)
      expect(closeSubscriptions.live).toBe(subscribed + count)
      expect(vi.getTimerCount()).toBe(count)
      // Reads never move the horizon.
      await status(runtime, ids[0] ?? '', { includeReleasePhase: true })
      expect(vi.getTimerCount()).toBe(count)

      await vi.advanceTimersByTimeAsync(DAY)
      for (const id of ids) {
        await expect(status(runtime, id)).resolves.toEqual({
          state: 'failed',
          code: 'agent_session_operation_expired',
          message:
            'Claude was not started because its first message was never sent. Send it again in a new chat.'
        })
      }
      expect(active.size).toBe(0)
      expect(closeSubscriptions.live).toBe(subscribed)
      expect(vi.getTimerCount()).toBe(0)
      noEffect(runtime)
    }
  )

  it('refuses an input arriving after the horizon even when the timer has not yet run', async () => {
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] })
    const runtime = hostRuntime()
    const id = operationId()
    const subscribed = closeSubscriptions.live
    await prepare(runtime, prepared(id))
    await untilAwaitingRelease(runtime, id)
    // A suspended machine wakes past the horizon before the timer fires.
    vi.setSystemTime(Date.now() + DAY)
    await expect(release(runtime, id)).resolves.toMatchObject({
      state: 'failed',
      code: 'agent_session_operation_expired'
    })
    expect(vi.getTimerCount()).toBe(0)
    expect(closeSubscriptions.live).toBe(subscribed)
    expect(activeAgentLaunchesFor(rpcContext(runtime, DESKTOP).runtime).size).toBe(0)
    noEffect(runtime)
  })
})

describe('the terminal alternative compiles with the released choices', () => {
  const CLAUDE = {
    agent: 'claude',
    head: 'my-claude',
    old: 'haiku',
    model: 'sonnet',
    args: '--verbose --model haiku --effort low',
    unrelated: '--verbose'
  } as const
  const CODEX = {
    agent: 'codex',
    head: 'cx',
    old: 'gpt-5.6-sol',
    model: 'gpt-5.5',
    args: '--profile work -m gpt-5.6-sol -c model_reasoning_effort=low',
    unrelated: '--profile'
  } as const
  const DRAFT = 'original draft A: issue context'

  function baseFor(d: typeof CLAUDE | typeof CODEX, command: string = d.head) {
    return resolveAgentStartupPlanInputs({
      agent: d.agent,
      settings: {
        agentCmdOverrides: { [d.agent]: command },
        agentDefaultArgs: { [d.agent]: d.args },
        agentDefaultEnv: { [d.agent]: { KEEP: 'unchanged' } }
      },
      platform: 'darwin',
      shell: 'posix',
      isRemote: false
    })
  }

  function argv(command: unknown): string[] {
    const parsed = tokenizeStartupCommand(String(command), 'posix')
    if (!parsed.ok) {
      throw new Error(parsed.error)
    }
    return parsed.tokens
  }

  it.each([
    {
      d: CLAUDE,
      policy: { kind: 'foreground', promptDelivery: 'auto-submit', isFollowupPath: false }
    },
    {
      d: CODEX,
      policy: {
        kind: 'background',
        prompt: '',
        draftPrompt: DRAFT,
        heldChatMessage: true,
        paired: false
      }
    }
  ] as const)(
    '$d.agent starts its planned terminal with the new choices',
    async ({ d, policy }) => {
      const runtime = hostRuntime(undefined, {
        createSupport: { supported: false, reason: 'agent' }
      })
      const id = operationId()
      await prepare(
        runtime,
        prepared(id, {
          agent: d.agent,
          sessionId: `${d.agent}_9b1deb4d_3b7d_4bad_9bdd_2b0d7b3dcb6d`,
          terminalAlternative: { kind: 'planned', base: baseFor(d), policy }
        })
      )
      await untilAwaitingRelease(runtime, id)
      expect(runtime.createTerminal).not.toHaveBeenCalled()
      const picked = { model: d.model, effort: 'high' }
      await release(runtime, id, { options: picked, selection: picked })
      await expect(status(runtime, id, { waitMs: 5_000 })).resolves.toMatchObject({
        state: 'succeeded',
        result: { outcome: { kind: 'terminal' } }
      })
      const options = runtime.createTerminal.mock.calls[0]?.[1]
      const tokens = argv(options?.command)
      expect(tokens[0]).toBe(d.head)
      expect(tokens).toContain(d.unrelated)
      expect(tokens).toContain(d.model)
      expect(tokens).not.toContain(d.old)
      expect(options).toMatchObject({ env: { KEEP: 'unchanged' }, launchAgent: d.agent })
      if (d.agent === 'codex') {
        // The plan's own draft is pasted once; the held message stays unsent.
        expect(runtime.pasteStartupDraftWhenReady.mock.calls).toEqual([
          ['term_1', { agent: 'codex', content: DRAFT }]
        ])
        expect(JSON.stringify(runtime.createTerminal.mock.calls)).not.toContain(HELD_MESSAGE)
      }
    }
  )

  it.each([CLAUDE, CODEX])('$agent recompiles an unchanged plan exactly', (d) => {
    const base = baseFor(d)
    const unchanged = Object.fromEntries(
      Object.entries(base.sessionOptions ?? {}).map(([key, value]) => [key, String(value)])
    )
    const foreground = {
      kind: 'foreground',
      promptDelivery: 'auto-submit',
      isFollowupPath: false
    } as const
    expect(
      compileAgentLaunchTerminalAlternative({
        alternative: { kind: 'planned', base, policy: foreground },
        heldText: HELD_MESSAGE,
        choices: unchanged,
        replaceModelSelection: false
      })
    ).toEqual({
      ok: true,
      startup: foregroundTerminalStartup(
        planLaunchAgentStartupPrompt({
          base,
          prompt: HELD_MESSAGE,
          promptDelivery: 'auto-submit',
          isFollowupPath: false
        }),
        HELD_MESSAGE
      )
    })
    const plan = planQuickAgentStartup(base, '', DRAFT)
    expect(plan).not.toBeNull()
    expect(
      compileAgentLaunchTerminalAlternative({
        alternative: {
          kind: 'planned',
          base,
          policy: {
            kind: 'background',
            prompt: '',
            draftPrompt: DRAFT,
            heldChatMessage: true,
            paired: true
          }
        },
        heldText: HELD_MESSAGE,
        choices: {},
        replaceModelSelection: false
      })
    ).toEqual({
      ok: true,
      startup: plan && backgroundTerminalStartup(plan, HELD_MESSAGE, true, false)
    })
  })

  it('refuses in the compiler’s words when a choice contradicts the user’s own command', async () => {
    const runtime = hostRuntime(undefined, { createSupport: { supported: false, reason: 'agent' } })
    const id = operationId()
    const literal = `${CLAUDE.head} --model haiku --effort low`
    await prepare(
      runtime,
      prepared(id, {
        terminalAlternative: {
          kind: 'planned',
          base: baseFor(CLAUDE, literal),
          policy: { kind: 'foreground', promptDelivery: 'auto-submit', isFollowupPath: false }
        }
      })
    )
    await untilAwaitingRelease(runtime, id)
    await release(runtime, id, { options: { model: 'sonnet' }, selection: { model: 'sonnet' } })
    await expect(status(runtime, id, { waitMs: 5_000 })).resolves.toEqual({
      state: 'failed',
      code: 'agent_launch_surface_unavailable',
      message: expect.stringContaining('Agent command override conflicts')
    })
    noEffect(runtime)
  })
})
