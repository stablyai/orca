import type { InternalCreateOrAttachOptions } from '../../../daemon/terminal-host-agent-session-claim'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import type { SleepingAgentLaunchConfig } from '../../../../shared/agent-session-resume'
import {
  formatPreparedLaunchGeneration,
  readCurrentPreparedLaunchIncarnation
} from '../../../daemon/prepared-agent-launch-incarnation'
import { randomUUID } from 'node:crypto'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ClaimedAgentPtyOwnerRegistry } from '../../../../shared/claimed-agent-pty-owner'
import { pendingAgentSessionOperationRow } from '../../../../shared/agent-session-operation-ledger'
import {
  isPreparedAgentLaunchStatus,
  type PreparedAgentLaunchDescriptor
} from '../../../../shared/prepared-agent-launch'
import { PreparedAgentLaunchOwner } from '../../../daemon/prepared-agent-launch-owner'
import { fingerprintPreparedAgentLaunch } from '../../../daemon/prepared-agent-launch-payload'
import type { RawPtySpawnObserver } from '../../../daemon/pty-subprocess'
import {
  publishPreparedTerminal,
  reconcilePreparedTerminalPublications,
  type PreparedPublicationPorts
} from './prepared-terminal-publication'

const NOW = 1_800_000_000_000
afterEach(() => vi.useRealTimers())

async function fixture(
  withSetup = false,
  accepted: {
    env?: Record<string, string>
    publication?: { launchConfig?: SleepingAgentLaunchConfig; viewMode?: 'terminal' | 'chat' }
    launchTokenHash?: string
  } = {}
) {
  vi.useFakeTimers({ now: NOW })
  const surfaces = {
    agent: { tabId: 'tab_agent', leafId: randomUUID(), terminalHandle: 'term_agent' },
    setup: { tabId: 'tab_setup', leafId: randomUUID(), terminalHandle: 'term_setup' }
  }
  const incarnations = { agent: randomUUID(), setup: randomUUID() }
  const attemptId = randomUUID()
  let observer: RawPtySpawnObserver | undefined
  const create = vi.fn(async (options: InternalCreateOrAttachOptions) => {
    observer = options.rawSpawnObserver?.() ?? observer
    observer?.onSelected()
    return {
      isNew: true,
      snapshot: null,
      pid: 42,
      shellState: 'ready' as const,
      wslDistro: null,
      attachToken: Symbol(),
      incarnationId: options.sessionId === 'agent' ? incarnations.agent : incarnations.setup
    }
  })
  const owner = new PreparedAgentLaunchOwner({
    owners: new ClaimedAgentPtyOwnerRegistry(),
    create,
    isAlive: () => true,
    reserveCapacity: () => () => {}
  })
  const payload = {
    launch: {
      sessionId: 'agent',
      cols: 80,
      rows: 24,
      command: 'cx',
      ...(accepted.env ? { env: accepted.env } : {})
    },
    prompts: { followup: { agent: 'codex' as const, prompt: 'full guarded prompt' } },
    ...(accepted.publication ? { publication: accepted.publication } : {}),
    ...(withSetup
      ? {
          setup: {
            spawn: { sessionId: 'setup', cols: 80, rows: 24 },
            attemptId,
            deadline: NOW + 7_200_000
          }
        }
      : {})
  }
  const prepared = await owner.handle({
    action: 'prepare',
    operationId: `${NOW}-${'a'.repeat(32)}`,
    fingerprint: fingerprintPreparedAgentLaunch(payload),
    claim: {
      kind: 'fresh-launch',
      agent: 'codex',
      keyId: 'key',
      identityDigest: 'a'.repeat(43),
      worktreeScopeDigest: 'b'.repeat(43),
      digestVersion: 1
    },
    surface: { worktreeId: 'wt', ...surfaces.agent }
  })
  if (!isPreparedAgentLaunchStatus(prepared)) {
    throw new Error('missing preparation')
  }
  const descriptor: PreparedAgentLaunchDescriptor = {
    daemonGeneration: prepared.daemonGeneration,
    reservationGeneration: prepared.reservationGeneration,
    hostScope: { hostId: 'local' },
    claim: prepared.claim,
    surface: prepared.surface,
    targetKind: 'new-git',
    launchTokenHash: accepted.launchTokenHash ?? null,
    presentation: {
      tabId: surfaces.agent.tabId,
      leafId: surfaces.agent.leafId,
      primary: true,
      color: 'blue'
    },
    ...(withSetup
      ? {
          setup: {
            operationId: prepared.operationId,
            attemptId,
            sessionId: 'setup',
            terminalHandle: 'term_setup',
            deadline: NOW + 7_200_000
          }
        }
      : {})
  }
  const row = {
    ...pendingAgentSessionOperationRow({
      callerKey: 'worktree-startup',
      operationId: prepared.operationId,
      fingerprint: prepared.fingerprint,
      now: NOW
    }),
    preparedLaunch: descriptor
  }
  const retire = vi.fn(async () => {
    Reflect.deleteProperty(row, 'preparedLaunch')
  })
  const createTerminal = vi.fn<PreparedPublicationPorts['createTerminal']>(
    async (_selector, options) => ({
      handle: options.sessionId === 'agent' ? 'term_agent' : 'term_setup',
      worktreeId: 'wt',
      ptyId: options.sessionId,
      incarnationId: options.sessionId === 'agent' ? incarnations.agent : incarnations.setup,
      title: null
    })
  )
  const ports: PreparedPublicationPorts = {
    controller: {
      preparedAgentLaunch: (request) => owner.handle(request),
      listProcesses: async () =>
        withSetup
          ? [
              {
                id: 'setup',
                cwd: '/work',
                title: 'Setup',
                terminalHandle: 'term_setup',
                incarnationId: incarnations.setup,
                paneKey: `${surfaces.setup.tabId}:${surfaces.setup.leafId}`
              }
            ]
          : []
    },
    store: { listOperationRows: () => [row], retirePreparedAgentLaunch: retire },
    createTerminal,
    placePrimary: vi.fn(async () => {}),
    setTabColor: vi.fn(async () => {}),
    deliverPrompts: vi.fn(async () => true)
  }
  await owner.handle({ action: 'accept', identity: prepared, ...payload })
  await vi.advanceTimersByTimeAsync(0)
  return {
    owner,
    identity: prepared,
    descriptor,
    ports,
    create,
    createTerminal,
    retire,
    zero: () => observer?.onData(`\n__ORCA_SETUP_COMPLETE__:${attemptId}:0\n`)
  }
}

describe('prepared terminal publication recovery', () => {
  it('rejoins an accepted physical result after a failed publication without executing again', async () => {
    const f = await fixture()
    f.createTerminal.mockRejectedValueOnce(new Error('save disconnected'))
    await expect(publishPreparedTerminal(f.identity, f.descriptor, f.ports)).rejects.toThrow(
      'save disconnected'
    )
    expect(await f.owner.handle({ action: 'status', identity: f.identity })).toMatchObject({
      execution: 'started',
      retirement: 'retained-live',
      published: false
    })
    await reconcilePreparedTerminalPublications(f.ports)
    expect(f.create).toHaveBeenCalledTimes(1)
    expect(f.createTerminal).toHaveBeenLastCalledWith(
      'id:wt',
      expect.objectContaining({
        sessionId: 'agent',
        expectedIncarnationId: expect.any(String),
        attachOnly: true,
        command: undefined,
        env: undefined
      })
    )
    expect(f.ports.deliverPrompts).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ handle: 'term_agent' }),
      { followup: { agent: 'codex', prompt: 'full guarded prompt' } }
    )
    expect(f.retire).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ operationId: f.identity.operationId })
    )
    expect(f.owner.pending).toBe(0)
  })

  it('recovers the interactive Setup pane, then publishes only the exact later agent incarnation', async () => {
    const f = await fixture(true)
    const publication = reconcilePreparedTerminalPublications(f.ports)
    await vi.advanceTimersByTimeAsync(0)
    expect(f.createTerminal).toHaveBeenCalledExactlyOnceWith(
      'id:wt',
      expect.objectContaining({
        sessionId: 'setup',
        preAllocatedHandle: 'term_setup',
        attachOnly: true
      })
    )
    expect(f.create).toHaveBeenCalledTimes(1)
    f.zero()
    await publication
    expect(f.create).toHaveBeenCalledTimes(2)
    expect(f.createTerminal).toHaveBeenCalledTimes(2)
    expect(f.retire).toHaveBeenCalledTimes(1)
  })

  it('places the delayed primary only on first publication and preserves later user placement', async () => {
    const f = await fixture(true)
    const publication = reconcilePreparedTerminalPublications(f.ports)
    await vi.advanceTimersByTimeAsync(0)
    expect(f.ports.placePrimary).not.toHaveBeenCalled()
    f.zero()
    await publication
    expect(f.ports.placePrimary).toHaveBeenCalledExactlyOnceWith(f.descriptor)
    await reconcilePreparedTerminalPublications(f.ports)
    expect(f.ports.placePrimary).toHaveBeenCalledTimes(1)
    expect(f.create).toHaveBeenCalledTimes(2)
  })

  it('retains the physical owner when the user closed its pane before publication', async () => {
    const f = await fixture()
    vi.mocked(f.ports.placePrimary!).mockRejectedValue(new Error('tab_not_found'))
    await expect(publishPreparedTerminal(f.identity, f.descriptor, f.ports)).rejects.toThrow(
      'tab_not_found'
    )
    expect(f.createTerminal).not.toHaveBeenCalled()
    expect(f.retire).not.toHaveBeenCalled()
    expect(await f.owner.handle({ action: 'status', identity: f.identity })).toMatchObject({
      execution: 'started',
      published: false,
      retirement: 'retained-live'
    })
  })

  it('settles a refused guarded prompt as uncertain once and never resubmits it', async () => {
    const f = await fixture()
    vi.mocked(f.ports.deliverPrompts).mockResolvedValue(false)
    const terminal = await publishPreparedTerminal(f.identity, f.descriptor, f.ports)
    await reconcilePreparedTerminalPublications(f.ports)
    expect(f.ports.deliverPrompts).toHaveBeenCalledTimes(1)
    expect(terminal?.warning).toContain(
      'Codex started, but its first prompt may not have been delivered'
    )
    expect(await f.owner.handle({ action: 'status', identity: f.identity })).toMatchObject({
      input: 'uncertain'
    })
    expect(f.retire).toHaveBeenCalledTimes(1)
    expect(f.owner.pending).toBe(0)
    expect(f.create).toHaveBeenCalledTimes(1)
  })

  it('recovers a prompt whose acquisition reply was lost and delivers it exactly once', async () => {
    const f = await fixture()
    const handle = f.ports.controller.preparedAgentLaunch!
    let dropped = 0
    f.ports.controller.preparedAgentLaunch = async (request) => {
      const reply = await handle(request)
      if (request.action === 'claimPrompt' && !request.attempt && dropped++ === 0) {
        throw new Error('daemon connection closed')
      }
      return reply
    }
    await expect(publishPreparedTerminal(f.identity, f.descriptor, f.ports)).rejects.toThrow(
      'daemon connection closed'
    )
    expect(f.ports.deliverPrompts).not.toHaveBeenCalled()
    await reconcilePreparedTerminalPublications(f.ports)
    await reconcilePreparedTerminalPublications(f.ports)
    expect(f.ports.deliverPrompts).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ handle: 'term_agent' }),
      { followup: { agent: 'codex', prompt: 'full guarded prompt' } }
    )
    expect(await f.owner.handle({ action: 'status', identity: f.identity })).toMatchObject({
      input: 'written'
    })
    expect(f.retire).toHaveBeenCalledTimes(1)
    expect(f.owner.pending).toBe(0)
    expect(f.create).toHaveBeenCalledTimes(1)
  })

  it('recovery after a main restart publishes the accepted recipe, view and authority', async () => {
    const token = 'launch-token'
    const launchConfig = {
      agentCommand: 'custom-cx',
      agentArgs: '--model o3',
      agentEnv: { CUSTOM_MODE: 'true' }
    }
    const f = await fixture(true, {
      env: { ORCA_AGENT_LAUNCH_TOKEN: token },
      publication: { launchConfig, viewMode: 'chat' },
      launchTokenHash: createHash('sha256').update(token).digest('hex')
    })
    // A restarted main has only the saved descriptor and no in-memory launch options.
    const publication = reconcilePreparedTerminalPublications(f.ports)
    await vi.advanceTimersByTimeAsync(0)
    f.zero()
    await publication
    expect(f.createTerminal).toHaveBeenLastCalledWith(
      'id:wt',
      expect.objectContaining({
        sessionId: 'agent',
        attachOnly: true,
        launchConfig,
        viewMode: 'chat',
        launchToken: token
      })
    )
  })

  it.each([1, 10])(
    'retires %i descriptors once their daemon process is proven gone and stops probing them',
    async (count) => {
      // A daemon process that has exited, named the way a generation records its owner.
      const gone = spawnSync(process.execPath, ['-e', ''])
      const generation = formatPreparedLaunchGeneration({
        pid: gone.pid!,
        process: `${process.platform}:exited-daemon`
      })
      const f = await fixture()
      const rows = Array.from({ length: count }, (_, index) => ({
        ...pendingAgentSessionOperationRow({
          callerKey: 'worktree-startup',
          operationId: `${NOW}-${String(index).padStart(32, '0')}`,
          fingerprint: 'fingerprint',
          now: NOW
        }),
        preparedLaunch: { ...f.descriptor, daemonGeneration: generation }
      }))
      const retire = vi.fn(async (identity: { operationId: string }) => {
        const row = rows.find((row) => row.operationId === identity.operationId)
        if (row) {
          Reflect.deleteProperty(row, 'preparedLaunch')
        }
      })
      const probes = vi.fn(async () => {
        throw new Error('agent_session_ownership_unknown')
      })
      const ports: PreparedPublicationPorts = {
        ...f.ports,
        controller: { preparedAgentLaunch: probes },
        store: { listOperationRows: () => rows, retirePreparedAgentLaunch: retire }
      }
      vi.useRealTimers()
      await reconcilePreparedTerminalPublications(ports)
      await reconcilePreparedTerminalPublications(ports)
      expect(retire).toHaveBeenCalledTimes(count)
      // Each dead owner is asked once; a retired descriptor is never probed again.
      expect(probes).toHaveBeenCalledTimes(count)
    }
  )

  it("keeps a descriptor whose daemon is unreachable but alive, and retires on that generation's answer", async () => {
    const f = await fixture()
    const live = await readCurrentPreparedLaunchIncarnation()
    const descriptor = {
      ...f.descriptor,
      daemonGeneration: formatPreparedLaunchGeneration(live)
    }
    const rows = [
      {
        ...pendingAgentSessionOperationRow({
          callerKey: 'worktree-startup',
          operationId: f.identity.operationId,
          fingerprint: f.identity.fingerprint,
          now: NOW
        }),
        preparedLaunch: descriptor
      }
    ]
    const reply = { error: new Error('agent_session_ownership_unknown') }
    const retire = vi.fn(async () => {})
    const ports: PreparedPublicationPorts = {
      ...f.ports,
      controller: {
        preparedAgentLaunch: async () => {
          throw reply.error
        }
      },
      store: { listOperationRows: () => rows, retirePreparedAgentLaunch: retire }
    }
    vi.useRealTimers()
    await reconcilePreparedTerminalPublications(ports)
    expect(retire).not.toHaveBeenCalled()
    reply.error = new Error('agent_session_operation_unknown')
    await reconcilePreparedTerminalPublications(ports)
    expect(retire).toHaveBeenCalledOnce()
  })
})
