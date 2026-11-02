import { randomUUID } from 'node:crypto'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ClaimedAgentPtyOwnerRegistry } from '../../../../shared/claimed-agent-pty-owner'
import { PreparedAgentLaunchOwner } from '../../../daemon/prepared-agent-launch-owner'
import type { InternalCreateOrAttachOptions } from '../../../daemon/terminal-host-agent-session-claim'
import type { RawPtySpawnObserver } from '../../../daemon/pty-subprocess'
import type { PreparedAgentLaunchDescriptor } from '../../../../shared/prepared-agent-launch'
import type { AgentSessionOperationOutcome } from '../../../../shared/agent-session/lifecycle/agent-session-operation-ledger'
import type { RuntimePtyController } from '../../runtime-pty-controller-contract'
import { startPreparedWorktreeTerminals } from './prepared-worktree-terminal-start'
import { OrcaRuntimeWithPreparedTerminals } from './prepared-terminal-runtime'
import { forgetPreparedPromptContinuation } from './prepared-terminal-prompt-delivery'
import { PreparedTerminalPendingError } from './prepared-terminal-pending'

afterEach(() => vi.useRealTimers())

/** The prepared path never writes, kills or inspects a terminal; those members only satisfy the contract. */
function controllerDouble(members: Partial<RuntimePtyController>): RuntimePtyController {
  return {
    write: () => false,
    kill: () => false,
    getForegroundProcess: async () => null,
    ...members
  }
}

async function fixture() {
  vi.useFakeTimers({ now: 1_800_000_000_000 })
  let setupObserver: RawPtySpawnObserver | undefined
  const incarnation = randomUUID()
  const create = vi.fn(async (opts: InternalCreateOrAttachOptions) => {
    if (opts.rawSpawnObserver) {
      setupObserver = opts.rawSpawnObserver()
      setupObserver.onSelected()
    }
    return {
      isNew: true,
      snapshot: null,
      pid: 42,
      shellState: 'ready' as const,
      wslDistro: null,
      attachToken: Symbol(),
      incarnationId: incarnation
    }
  })
  const notice = vi.fn()
  const owner = new PreparedAgentLaunchOwner({
    owners: new ClaimedAgentPtyOwnerRegistry(),
    create,
    isAlive: () => true,
    reserveCapacity: () => () => {},
    notice
  })
  let row:
    | {
        operationId: string
        fingerprint: string
        preparedLaunch?: PreparedAgentLaunchDescriptor
        outcome?: AgentSessionOperationOutcome
      }
    | undefined
  const ports = {
    controller: controllerDouble({
      preparedAgentLaunch: (request: Parameters<typeof owner.handle>[0]) => owner.handle(request)
    }),
    store: {
      recordPreparedAgentLaunch: vi.fn(
        async (args: {
          operationId: string
          fingerprint: string
          preparedLaunch: PreparedAgentLaunchDescriptor
        }) => {
          // A won claim leaves the outcome unknown until the launch's answer is saved.
          row = { ...args, outcome: { status: 'unknown' } }
          return { claim: { claim: 'won' as const } }
        }
      ),
      retirePreparedAgentLaunch: vi.fn(async (args: { answer?: unknown }) => {
        if (!row?.preparedLaunch) {
          return false
        }
        delete row.preparedLaunch
        if (args.answer) {
          row.outcome = { status: 'succeeded', sessionId: '', launch: args.answer }
        }
        return true
      }),
      listOperationRows: () => (row ? [row] : [])
    },
    prepare: vi.fn(async (options: { command?: string; title?: string }) => {
      const setup = options.title === 'Setup'
      return {
        spawn: {
          sessionId: setup ? 'setup' : 'agent',
          cols: 80,
          rows: 24,
          command: options.command
        },
        surface: {
          worktreeId: 'wt',
          tabId: setup ? 'tab_setup' : 'tab_agent',
          leafId: randomUUID(),
          terminalHandle: setup ? 'term_setup' : 'term_agent'
        },
        options,
        commit() {},
        release() {}
      }
    }),
    createClaim: () => ({
      kind: 'fresh-launch' as const,
      agent: 'codex' as const,
      keyId: 'key',
      identityDigest: 'a'.repeat(43),
      worktreeScopeDigest: 'b'.repeat(43),
      digestVersion: 1 as const
    }),
    createTerminal: vi.fn(async (_selector: string, opts: { sessionId?: string }) => ({
      handle: opts.sessionId === 'setup' ? 'term_setup' : 'term_agent',
      worktreeId: 'wt',
      ptyId: opts.sessionId,
      incarnationId: incarnation,
      title: null
    })),
    setTabColor: vi.fn(async () => {}),
    placePrimary: vi.fn(async () => {}),
    deliverPrompts: vi.fn(async (): Promise<boolean> => true),
    notifyLaunchNotice: vi.fn()
  }
  const notifier = { preparedAgentLaunchNotice: vi.fn() }
  // Only main's own PTY records are a seam: the waiter reads the published agent from them.
  const runtime = Object.assign(Object.create(OrcaRuntimeWithPreparedTerminals.prototype), {
    ptyController: ports.controller,
    notifier,
    openAgentSessionRecordStore: async () => ports.store,
    createTerminal: ports.createTerminal,
    getWorktreeTerminalProvisioningHost: () => ({ setTabColor: ports.setTabColor }),
    placePreparedPrimary: ports.placePrimary,
    deliverPreparedTerminalPrompts: ports.deliverPrompts,
    getLivePtyForHandle: (handle: string) =>
      handle === 'term_agent' ? { pty: { ptyId: 'agent', incarnationId: incarnation } } : null
  })
  const wait = (
    identity: Parameters<OrcaRuntimeWithPreparedTerminals['waitForPreparedAgentTerminal']>[0]
  ) =>
    // SAFETY: the waiter reads only the controller, operation store and PTY records injected above.
    OrcaRuntimeWithPreparedTerminals.prototype.waitForPreparedAgentTerminal.call(
      runtime as never,
      identity
    )
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the start path reads only the record, retire and list members doubled above.
  const startPorts = { ...ports, store: ports.store as never }
  return {
    owner,
    ports,
    startPorts,
    runtime,
    create,
    notice,
    notifier,
    wait,
    setupObserver: () => setupObserver!
  }
}

describe('late prepared agent waiter', () => {
  it('joins an agent whose background publication already retired its descriptor', async () => {
    const f = await fixture()
    const started = await startPreparedWorktreeTerminals({
      worktreeId: 'wt',
      targetKind: 'new-git',
      startupOptions: { command: 'codex', launchAgent: 'codex' },
      ports: f.startPorts
    })
    // Provisioning the remaining configured tabs can finish after the automatic publication.
    await vi.advanceTimersByTimeAsync(0)
    expect(f.ports.store.listOperationRows()[0]?.preparedLaunch).toBeUndefined()
    await expect(f.wait(started.pending)).resolves.toMatchObject({
      handle: 'term_agent',
      ptyId: 'agent',
      tabId: 'tab_agent'
    })
    expect(f.create).toHaveBeenCalledTimes(1)
    expect(f.ports.createTerminal).toHaveBeenCalledTimes(1)
  })

  it("gives every waiter the creator's one refused-prompt answer and writes once", async () => {
    const f = await fixture()
    const delivery = Promise.withResolvers<boolean>()
    f.ports.deliverPrompts.mockReturnValueOnce(delivery.promise)
    const started = await startPreparedWorktreeTerminals({
      worktreeId: 'wt',
      targetKind: 'new-git',
      startupOptions: { command: 'codex', launchAgent: 'codex' },
      prompts: { followup: { agent: 'codex', prompt: 'the complete task' } },
      ports: f.startPorts
    })
    vi.useRealTimers()
    // A caller waiting while the creator still delivers joins it instead of reporting success.
    let answered = false
    const waiting = f.wait(started.pending).finally(() => {
      answered = true
    })
    await vi.waitFor(() => expect(f.ports.deliverPrompts).toHaveBeenCalledOnce())
    expect(answered).toBe(false)
    delivery.resolve(false)
    const terminal = await waiting
    expect(terminal.warning).toBe(
      'Codex started, but its first prompt may not have been delivered. Check Codex before sending the prompt again.'
    )
    // A later waiter reads the recorded answer and never writes or notifies again.
    await expect(f.wait(started.pending)).resolves.toMatchObject({ warning: terminal.warning })
    expect(f.ports.deliverPrompts).toHaveBeenCalledOnce()
    const notices = [
      ...f.ports.notifyLaunchNotice.mock.calls,
      ...f.notifier.preparedAgentLaunchNotice.mock.calls
    ]
    expect(notices).toEqual([
      [
        expect.objectContaining({
          operationId: started.pending.operationId,
          kind: 'prompt-uncertain'
        })
      ]
    ])
  })

  it('never reports a recovered launch with no draft or followup as having lost its prompt', async () => {
    const f = await fixture()
    // The first publication fails, so the saved launch is recovered without any creator, as after a restart.
    f.ports.createTerminal.mockRejectedValueOnce(new Error('main restarted'))
    const started = await startPreparedWorktreeTerminals({
      worktreeId: 'wt',
      targetKind: 'new-git',
      // The task already rides in the command; the runtime passes an empty bundle beside it.
      startupOptions: { command: "codex 'the complete task'", launchAgent: 'codex' },
      prompts: {},
      ports: f.startPorts
    })
    vi.useRealTimers()
    await vi.waitFor(() => expect(f.ports.createTerminal).toHaveBeenCalledOnce())
    await new Promise((resolve) => setImmediate(resolve))
    expect(
      f.ports.store.recordPreparedAgentLaunch.mock.calls[0][0].preparedLaunch
    ).not.toHaveProperty('promptOwnerRef')
    const terminal = await f.wait(started.pending)
    expect(terminal.warning).toBeUndefined()
    expect(f.ports.deliverPrompts).not.toHaveBeenCalled()
    expect(f.ports.notifyLaunchNotice).not.toHaveBeenCalled()
    expect(f.notifier.preparedAgentLaunchNotice).not.toHaveBeenCalled()
  })

  it('reports a Setup timeout once in Setup and names the agent to an attached caller', async () => {
    const f = await fixture()
    const started = await startPreparedWorktreeTerminals({
      worktreeId: 'wt',
      targetKind: 'new-git',
      setup: {
        runnerScriptPath: '/work/.git/orca/setup-runner.sh',
        envVars: {},
        waitForAgentStartup: true
      },
      startupOptions: { command: 'codex', launchAgent: 'codex' },
      ports: f.startPorts
    })
    const waiting = f.wait(started.pending)
    const outcome = expect(waiting).rejects.toThrow(
      'Setup did not finish within 2 hours, so Codex was not started.'
    )
    await vi.advanceTimersByTimeAsync(2 * 60 * 60_000)
    await outcome
    expect(f.notice).toHaveBeenCalledExactlyOnceWith(
      'setup',
      expect.stringContaining('Setup did not finish within 2 hours, so Codex was not started.')
    )
    // A late marker after the deadline never revives the launch.
    f.setupObserver().onData(`\n__ORCA_SETUP_COMPLETE__:x:0\n`)
    expect(f.create).toHaveBeenCalledTimes(1)
    expect(f.ports.store.retirePreparedAgentLaunch).toHaveBeenCalledOnce()
  })

  it('gives a waiter held before its join the recorded answer of a creator that wrote', async () => {
    const f = await fixture()
    const delivery = Promise.withResolvers<boolean>()
    f.ports.deliverPrompts.mockReturnValueOnce(delivery.promise)
    const started = await startPreparedWorktreeTerminals({
      worktreeId: 'wt',
      targetKind: 'new-git',
      startupOptions: { command: 'codex', launchAgent: 'codex' },
      prompts: { followup: { agent: 'codex', prompt: 'the complete task' } },
      ports: f.startPorts
    })
    vi.useRealTimers()
    await vi.waitFor(() => expect(f.ports.deliverPrompts).toHaveBeenCalledOnce())
    // The waiter's own controller holds its acknowledgement, the step before it joins the creator.
    const held = Promise.withResolvers<void>()
    const acknowledging = Promise.withResolvers<void>()
    f.runtime.ptyController = controllerDouble({
      preparedAgentLaunch: async (request: Parameters<typeof f.owner.handle>[0]) => {
        const reply = await f.owner.handle(request)
        if (request.action === 'ackPublication') {
          acknowledging.resolve()
          await held.promise
        }
        return reply
      }
    })
    const waiting = f.wait(started.pending)
    await acknowledging.promise
    // The creator writes, saves its answer and forgets its continuation before the waiter joins.
    delivery.resolve(true)
    await vi.waitFor(() =>
      expect(f.ports.store.listOperationRows()[0]?.preparedLaunch).toBeUndefined()
    )
    held.resolve()
    const terminal = await waiting
    expect(terminal).toMatchObject({ handle: 'term_agent', ptyId: 'agent' })
    expect(terminal.warning).toBeUndefined()
    expect(f.ports.deliverPrompts).toHaveBeenCalledOnce()
    expect(f.ports.notifyLaunchNotice).not.toHaveBeenCalled()
    expect(f.notifier.preparedAgentLaunchNotice).not.toHaveBeenCalled()
  })

  it("keeps this main's own launch pending when neither its creator nor an answer remains", async () => {
    const f = await fixture()
    // The creator's publication fails, then its continuation is gone with no answer saved.
    f.ports.createTerminal.mockRejectedValueOnce(new Error('attach failed'))
    const started = await startPreparedWorktreeTerminals({
      worktreeId: 'wt',
      targetKind: 'new-git',
      startupOptions: { command: 'codex', launchAgent: 'codex' },
      prompts: { followup: { agent: 'codex', prompt: 'the complete task' } },
      ports: f.startPorts
    })
    vi.useRealTimers()
    await vi.waitFor(() => expect(f.ports.createTerminal).toHaveBeenCalledOnce())
    await new Promise((resolve) => setImmediate(resolve))
    forgetPreparedPromptContinuation(started.pending)

    await expect(f.wait(started.pending)).rejects.toBeInstanceOf(PreparedTerminalPendingError)
    // Neither success nor uncertainty is invented: the obligation stays and nothing is written.
    expect(f.ports.store.listOperationRows()[0]?.preparedLaunch).toBeDefined()
    expect(f.ports.deliverPrompts).not.toHaveBeenCalled()
    expect(f.ports.notifyLaunchNotice).not.toHaveBeenCalled()
    expect(f.notifier.preparedAgentLaunchNotice).not.toHaveBeenCalled()
  })
})
