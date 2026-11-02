import { spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ClaimedAgentPtyOwnerRegistry } from '../../../../shared/claimed-agent-pty-owner'
import { PreparedAgentLaunchOwner } from '../../../daemon/prepared-agent-launch-owner'
import type { InternalCreateOrAttachOptions } from '../../../daemon/terminal-host-agent-session-claim'
import type { RawPtySpawnObserver } from '../../../daemon/pty-subprocess'
import type { PreparedAgentLaunchDescriptor } from '../../../../shared/prepared-agent-launch'
import { startPreparedWorktreeTerminals } from './prepared-worktree-terminal-start'
import { OrcaRuntimeWithPreparedTerminals } from './prepared-terminal-runtime'

afterEach(() => vi.useRealTimers())

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
    | { operationId: string; fingerprint: string; preparedLaunch?: PreparedAgentLaunchDescriptor }
    | undefined
  const ports = {
    controller: {
      preparedAgentLaunch: (request: Parameters<typeof owner.handle>[0]) => owner.handle(request)
    },
    store: {
      recordPreparedAgentLaunch: vi.fn(
        async (args: {
          operationId: string
          fingerprint: string
          preparedLaunch: PreparedAgentLaunchDescriptor
        }) => {
          row = { ...args }
          return { claim: { claim: 'won' as const } }
        }
      ),
      retirePreparedAgentLaunch: vi.fn(async () => {
        delete row?.preparedLaunch
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
    deliverPrompts: vi.fn(async () => true),
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
  return { owner, ports, create, notice, notifier, wait, setupObserver: () => setupObserver! }
}

describe('late prepared agent waiter', () => {
  it('joins an agent whose background publication already retired its descriptor', async () => {
    const f = await fixture()
    const started = await startPreparedWorktreeTerminals({
      worktreeId: 'wt',
      targetKind: 'new-git',
      startupOptions: { command: 'codex', launchAgent: 'codex' },
      ports: f.ports
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

  it("reports a dead writer's prompt as uncertain once to the waiter and the desktop, never resending it", async () => {
    const f = await fixture()
    // A previous main won the write grant, then exited before settling it.
    const gone = spawnSync(process.execPath, ['-e', ''])
    const handle = f.ports.controller.preparedAgentLaunch
    f.ports.controller.preparedAgentLaunch = async (request) => {
      const reply = await handle(request)
      if (request.action === 'ackPublication') {
        await handle({
          action: 'claimPrompt',
          identity: request.identity,
          consumer: { id: 'previous-main', pid: gone.pid! },
          attempt: 'previous-attempt'
        })
      }
      return reply
    }
    const started = await startPreparedWorktreeTerminals({
      worktreeId: 'wt',
      targetKind: 'new-git',
      startupOptions: { command: 'codex', launchAgent: 'codex' },
      prompts: { followup: { agent: 'codex', prompt: 'the complete task' } },
      ports: f.ports
    })
    vi.useRealTimers()
    const terminal = await f.wait(started.pending)
    expect(terminal.warning).toBe(
      'Codex started, but its first prompt may not have been delivered. Check Codex before sending the prompt again.'
    )
    expect(f.ports.deliverPrompts).not.toHaveBeenCalled()
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
    // A later waiter reads the same retained receipt and still never writes.
    await expect(f.wait(started.pending)).resolves.toMatchObject({ warning: terminal.warning })
    expect(f.ports.deliverPrompts).not.toHaveBeenCalled()
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
      ports: f.ports
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
})
