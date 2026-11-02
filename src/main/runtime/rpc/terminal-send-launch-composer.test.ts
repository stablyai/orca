import './unused-default-rpc-methods.test-fixture'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { OrcaRuntimeService } from '../orca-runtime'
import { makeStore } from '../runtime-rpc-worktree-store-fixtures'
import { AGENT_PROMPT_TEST_WORKTREE_PATH } from '../agent-prompt-submission-runtime-test-fixture'
import { RpcDispatcher } from './dispatcher'
import { TERMINAL_METHODS } from './methods/terminal'
import { randomUUID } from 'node:crypto'
import { publishPreparedTerminal } from '../terminal/launch/prepared-terminal-publication'
import type { PreparedAgentLaunchRequest } from '../../daemon/prepared-agent-launch-protocol'
import type { PreparedAgentLaunchDescriptor } from '../../../shared/prepared-agent-launch'

vi.mock('../../git/worktree', () => ({
  listWorktrees: vi.fn().mockResolvedValue([
    {
      path: '/tmp/worktree-a',
      head: 'abc',
      branch: 'feature/launch-composer',
      isBare: false,
      isMainWorktree: false
    }
  ]),
  listWorktreesStrict: vi.fn().mockResolvedValue([
    {
      path: '/tmp/worktree-a',
      head: 'abc',
      branch: 'feature/launch-composer',
      isBare: false,
      isMainWorktree: false
    }
  ])
}))

// Claude's palette-report anchor, then its composer prompt row (draft-paste-ready-scanner.ts).
const CLAUDE_COMPOSER_READY_OUTPUT = '\x1b[?2031h\x1b[?2004h❯\u00a0'
const PTY_ID = 'pty-claude'
// Claude 2.1.314's first-launch trust menu, captured from a real PTY.
const CLAUDE_TRUST_DIALOG_OUTPUT =
  '\x1b[?2004h Accessing workspace:\r\n\r\n /private/tmp/repro\r\n\r\n' +
  ' Quick safety check: Is this a project you created or one you trust?\r\n\r\n' +
  ' ❯ No, exit\r\n   Yes, I trust this folder\r\n\r\n Enter to confirm · Esc to cancel\r\n'

async function launchClaude(command: string | undefined) {
  const runtime = new OrcaRuntimeService(
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: partial store double; terminal create and send read only its repo and worktree members.
    makeStore() as never
  )
  const writes: string[] = []
  runtime.setPtyController({
    spawn: async () => ({ id: PTY_ID }),
    write: (_ptyId, data) => {
      writes.push(data)
      return true
    },
    kill: () => true,
    getForegroundProcess: async () => 'claude'
  })
  const { handle } = await runtime.createTerminal(`path:${AGENT_PROMPT_TEST_WORKTREE_PATH}`, {
    launchAgent: 'claude',
    ...(command ? { command } : {})
  })
  vi.spyOn(runtime, 'readLaunchedAgentForeground').mockResolvedValue('agent')
  const dispatcher = new RpcDispatcher({ runtime, methods: TERMINAL_METHODS })
  const send = (text: string, signal?: AbortSignal) =>
    dispatcher.dispatch(
      {
        id: 'rpc-send',
        authToken: 'token',
        method: 'terminal.send',
        params: { terminal: handle, text, enter: true }
      },
      signal ? { signal } : undefined
    )
  return { runtime, writes, send }
}

const PASTE = '\x1b[200~/review\nthis\x1b[201~'
const INCARNATION_ID = 'prepared-claude-incarnation'

/** Publishes a daemon-started Claude the way prepared publication attaches it. */
async function attachPreparedClaude(preparedFirstPublication: boolean) {
  const runtime = new OrcaRuntimeService(
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: partial store double; terminal create and send read only its repo and worktree members.
    makeStore() as never
  )
  const writes: string[] = []
  runtime.setPtyController({
    spawn: async (args) => {
      // The pty host's commit registers first, restoring the daemon-owned agent identity.
      runtime.registerPty(PTY_ID, args.worktreeId ?? '', null, {
        tabId: args.tabId ?? '',
        leafId: args.leafId ?? '',
        incarnationId: INCARNATION_ID,
        providerReattachLaunchIdentity: { incarnationId: INCARNATION_ID, launchAgent: 'claude' }
      })
      return { id: PTY_ID, incarnationId: INCARNATION_ID, isReattach: true, launchAgent: 'claude' }
    },
    write: (_ptyId, data) => {
      writes.push(data)
      return true
    },
    kill: () => true,
    getForegroundProcess: async () => 'claude'
  })
  const { handle } = await runtime.createTerminal(`path:${AGENT_PROMPT_TEST_WORKTREE_PATH}`, {
    sessionId: PTY_ID,
    attachOnly: true,
    expectedIncarnationId: INCARNATION_ID,
    launchAgent: 'claude',
    ...(preparedFirstPublication ? { preparedFirstPublication: true as const } : {})
  })
  vi.spyOn(runtime, 'readLaunchedAgentForeground').mockResolvedValue('agent')
  const dispatcher = new RpcDispatcher({ runtime, methods: TERMINAL_METHODS })
  const send = (text: string) =>
    dispatcher.dispatch({
      id: 'rpc-send',
      authToken: 'token',
      method: 'terminal.send',
      params: { terminal: handle, text, enter: true }
    })
  return { runtime, writes, send }
}

describe('terminal.send into a freshly launched Claude', () => {
  afterEach(() => vi.useRealTimers())

  // A command override keeps the planned agent, so its launch is held too.
  it.each(['claude', 'my-claude'])(
    'holds the submit until the composer is drawn (#34580, %s)',
    async (command) => {
      vi.useFakeTimers()
      const { runtime, writes, send } = await launchClaude(command)

      const sending = send(PASTE)
      await vi.advanceTimersByTimeAsync(3_000)
      expect(writes).toEqual([])

      runtime.onPtyData(PTY_ID, CLAUDE_COMPOSER_READY_OUTPUT, Date.now())
      await vi.runAllTimersAsync()

      await expect(sending).resolves.toMatchObject({
        ok: true,
        result: { send: { accepted: true } }
      })
      expect(writes).toEqual([PASTE, '\r'])
    }
  )

  it('refuses the send, writing nothing, when the composer never comes up', async () => {
    vi.useFakeTimers()
    const { writes, send } = await launchClaude('claude')

    const sending = send(PASTE)
    await vi.runAllTimersAsync()

    await expect(sending).resolves.toMatchObject({
      ok: true,
      result: { send: { accepted: false, bytesWritten: 0 } }
    })
    expect(writes).toEqual([])
  })

  it('lets an answer reach a startup dialog shown before the composer', async () => {
    vi.useFakeTimers()
    const { runtime, writes, send } = await launchClaude('claude')

    const sending = send('1')
    runtime.onPtyData(PTY_ID, CLAUDE_TRUST_DIALOG_OUTPUT, Date.now())
    await vi.advanceTimersByTimeAsync(3_000)

    await expect(sending).resolves.toMatchObject({ ok: true, result: { send: { accepted: true } } })
    expect(writes).toEqual(['1', '\r'])
  })

  it('writes nothing for a held send whose request was cancelled', async () => {
    vi.useFakeTimers()
    const { runtime, writes, send } = await launchClaude('claude')
    const request = new AbortController()

    const sending = send(PASTE, request.signal)
    await vi.advanceTimersByTimeAsync(1_000)
    request.abort()
    runtime.onPtyData(PTY_ID, CLAUDE_COMPOSER_READY_OUTPUT, Date.now())
    await vi.runAllTimersAsync()

    await sending
    expect(writes).toEqual([])
  })

  // A resume tab types its own `claude --resume`; a headless `--print` run never draws a composer.
  it.each([undefined, 'claude --print task'])(
    'does not hold sends to a shell tagged for Claude that starts no composer (%s)',
    async (command) => {
      const { writes, send } = await launchClaude(command)

      await expect(send('claude --resume abc')).resolves.toMatchObject({
        ok: true,
        result: { send: { accepted: true } }
      })
      expect(writes).toEqual(['claude --resume abc', '\r'])
    }
  )
})

describe('terminal.send into a published prepared Claude', () => {
  afterEach(() => vi.useRealTimers())

  it('holds the submit after its first publication, as for a typed launch (#34580)', async () => {
    vi.useFakeTimers()
    const { runtime, writes, send } = await attachPreparedClaude(true)

    const sending = send(PASTE)
    await vi.advanceTimersByTimeAsync(3_000)
    expect(writes).toEqual([])

    runtime.onPtyData(PTY_ID, CLAUDE_COMPOSER_READY_OUTPUT, Date.now())
    await vi.runAllTimersAsync()

    await expect(sending).resolves.toMatchObject({ ok: true, result: { send: { accepted: true } } })
    expect(writes).toEqual([PASTE, '\r'])
  })

  it('does not hold sends to a later reattachment of the same agent', async () => {
    const { writes, send } = await attachPreparedClaude(false)

    await expect(send(PASTE)).resolves.toMatchObject({
      ok: true,
      result: { send: { accepted: true } }
    })
    expect(writes).toEqual([PASTE, '\r'])
  })
})

const WORKTREE_ID = 'repo-1::/tmp/worktree-a'
const CLAIM = {
  kind: 'fresh-launch' as const,
  agent: 'claude' as const,
  keyId: 'key',
  identityDigest: 'a'.repeat(43),
  worktreeScopeDigest: 'b'.repeat(43),
  digestVersion: 1 as const
}

/** One accepted prepared Claude whose daemon owner answers every publication controller. */
function preparedLaunch(incarnationId: string) {
  const surface = {
    worktreeId: WORKTREE_ID,
    tabId: 'tab_agent',
    leafId: randomUUID(),
    terminalHandle: `term_${randomUUID()}`
  }
  const identity = {
    operationId: `${Date.now()}-${randomUUID().replaceAll('-', '')}`,
    fingerprint: 'fingerprint',
    daemonGeneration: 'daemon',
    reservationGeneration: 'reservation'
  }
  const descriptor: PreparedAgentLaunchDescriptor = {
    daemonGeneration: identity.daemonGeneration,
    reservationGeneration: identity.reservationGeneration,
    hostScope: { hostId: 'local' },
    claim: CLAIM,
    surface,
    targetKind: 'new-git',
    launchTokenHash: null,
    presentation: { tabId: surface.tabId, leafId: surface.leafId, primary: false }
  }
  let published = false
  const status = () => ({
    ...identity,
    claim: CLAIM,
    surface,
    accepted: true,
    execution: 'started',
    retirement: published ? 'unused-retired' : 'retained-live',
    physical: { sessionId: PTY_ID, incarnationId, startedAt: 0 },
    published
  })
  const owner = async (request: PreparedAgentLaunchRequest['payload']) => {
    if (request.action === 'ackPublication') {
      published = true
    }
    return status()
  }
  return { identity, descriptor, owner }
}

/** Publication ports of one controller scope; its daemon replies can be held by the test. */
function publicationScope(
  runtime: OrcaRuntimeService,
  launch: ReturnType<typeof preparedLaunch>,
  hold?: Promise<void>
) {
  const controller = {
    write: () => false,
    kill: () => false,
    getForegroundProcess: async () => null,
    preparedAgentLaunch: async (request: PreparedAgentLaunchRequest['payload']) => {
      // The recipe read follows this scope's first status, so its snapshot can go stale meanwhile.
      if (hold && request.action === 'status' && request.publication) {
        await hold
      }
      return launch.owner(request)
    }
  }
  return {
    controller,
    store: {
      listOperationRows: () => [],
      getOperationRow: () => null,
      retirePreparedAgentLaunch: async () => false
    },
    createTerminal: (
      selector: string,
      options: Parameters<OrcaRuntimeService['createTerminal']>[1]
    ) => runtime.createTerminal(selector, options),
    setTabColor: async () => {}
  }
}

/** A runtime whose PTY host attaches the daemon's accepted Claude process. */
function preparedRuntime() {
  const runtime = new OrcaRuntimeService(
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: partial store double; terminal create and send read only its repo and worktree members.
    makeStore() as never
  )
  const writes: string[] = []
  let incarnationId = 'incarnation-1'
  runtime.setPtyController({
    spawn: async (args) => {
      runtime.registerPty(PTY_ID, args.worktreeId ?? '', null, {
        tabId: args.tabId ?? '',
        leafId: args.leafId ?? '',
        incarnationId,
        providerReattachLaunchIdentity: { incarnationId, launchAgent: 'claude' }
      })
      return { id: PTY_ID, incarnationId, isReattach: true, launchAgent: 'claude' }
    },
    write: (_ptyId, data) => {
      writes.push(data)
      return true
    },
    kill: () => true,
    getForegroundProcess: async () => 'claude'
  })
  vi.spyOn(runtime, 'readLaunchedAgentForeground').mockResolvedValue('agent')
  const watches = vi.spyOn(runtime, 'watchLaunchComposer')
  const dispatcher = new RpcDispatcher({ runtime, methods: TERMINAL_METHODS })
  const send = (terminal: string, text: string) =>
    dispatcher.dispatch({
      id: 'rpc-send',
      authToken: 'token',
      method: 'terminal.send',
      params: { terminal, text, enter: true }
    })
  const replace = (next: string) => {
    incarnationId = next
  }
  return { runtime, writes, send, replace, watches }
}

describe('overlapping publications of one prepared Claude', () => {
  afterEach(() => vi.useRealTimers())

  it('starts one startup hold per process, so a late publication never holds a ready agent', async () => {
    vi.useFakeTimers()
    const { runtime, writes, send, replace, watches } = preparedRuntime()
    const launch = preparedLaunch('incarnation-1')
    const late = Promise.withResolvers<void>()
    // B reads the unpublished status first, then waits; A publishes the same process meanwhile.
    const b = publishPreparedTerminal(
      launch.identity,
      launch.descriptor,
      publicationScope(runtime, launch, late.promise)
    )
    await vi.advanceTimersByTimeAsync(0)
    const a = await publishPreparedTerminal(
      launch.identity,
      launch.descriptor,
      publicationScope(runtime, launch)
    )
    runtime.onPtyData(PTY_ID, CLAUDE_COMPOSER_READY_OUTPUT, Date.now())
    await vi.advanceTimersByTimeAsync(3_000)
    // The ready marker leaves recent output long before B is released.
    runtime.onPtyData(PTY_ID, 'x'.repeat(70 * 1024), Date.now())
    late.resolve()
    await b
    const sending = send(a!.handle, PASTE)
    // Well inside the startup hold's own deadline: a held send would still have written nothing.
    await vi.advanceTimersByTimeAsync(1_000)
    expect(writes).toEqual([PASTE, '\r'])
    await expect(sending).resolves.toMatchObject({ ok: true, result: { send: { accepted: true } } })
    const initializations = () => watches.mock.calls.filter(([, agent]) => agent !== null)
    expect(initializations()).toHaveLength(1)

    // A genuine replacement process is a new launch and gets its own startup hold.
    replace('incarnation-2')
    const next = preparedLaunch('incarnation-2')
    const replaced = await publishPreparedTerminal(
      next.identity,
      next.descriptor,
      publicationScope(runtime, next)
    )
    expect(initializations()).toHaveLength(2)
    writes.length = 0
    const held = send(replaced!.handle, PASTE)
    await vi.advanceTimersByTimeAsync(3_000)
    expect(writes).toEqual([])
    runtime.onPtyData(PTY_ID, CLAUDE_COMPOSER_READY_OUTPUT, Date.now())
    await vi.runAllTimersAsync()
    await expect(held).resolves.toMatchObject({ ok: true, result: { send: { accepted: true } } })
  })
})
