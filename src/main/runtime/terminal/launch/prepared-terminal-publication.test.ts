import type { InternalCreateOrAttachOptions } from '../../../daemon/terminal-host-agent-session-claim'
import { spawnSync } from 'node:child_process'
import type * as HostIdentity from '../../../agent-hooks/managed-hook-owner-identity'
import { readBootIdentity } from '../../../agent-hooks/managed-hook-owner-identity'
import type * as ProcessInspection from '../../../daemon/daemon-process-inspection'
import {
  queryWindowsProcess,
  readLinuxStat,
  readMacosProcessStartedAtMs
} from '../../../daemon/daemon-process-inspection'
import { createHash, randomUUID } from 'node:crypto'
import type { SleepingAgentLaunchConfig } from '../../../../shared/agent-session/lifecycle/agent-session-resume'
import {
  formatPreparedLaunchGeneration,
  readCurrentPreparedLaunchIncarnation
} from '../../../daemon/prepared-agent-launch-incarnation'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ClaimedAgentPtyOwnerRegistry } from '../../../../shared/claimed-agent-pty-owner'
import {
  pendingAgentSessionOperationRow,
  type AgentSessionOperationOutcome,
  type AgentSessionOperationRow
} from '../../../../shared/agent-session/lifecycle/agent-session-operation-ledger'
import {
  isPreparedAgentLaunchStatus,
  type PreparedAgentLaunchDescriptor
} from '../../../../shared/prepared-agent-launch'
import { PreparedAgentLaunchOwner } from '../../../daemon/prepared-agent-launch-owner'
import { fingerprintPreparedAgentLaunch } from '../../../daemon/prepared-agent-launch-payload'
import type { RawPtySpawnObserver } from '../../../daemon/pty-subprocess'
import { reportSetupStatus } from '../../../daemon/prepared-setup-status-test-harness'
import {
  publishPreparedTerminal,
  reconcilePreparedTerminalPublications,
  type PreparedPublicationPorts
} from './prepared-terminal-publication'
import { installPreparedPromptContinuation } from './prepared-terminal-prompt-delivery'
import type { RuntimePtyController } from '../../runtime-pty-controller-contract'

/** The saved ledger as publication reads it: one enumeration, then exact rows by key. */
function storeOf(
  rows: AgentSessionOperationRow[],
  retire: PreparedPublicationPorts['store']['retirePreparedAgentLaunch']
): PreparedPublicationPorts['store'] {
  return {
    listOperationRows: () => rows,
    getOperationRow: (callerKey, operationId) =>
      rows.find((row) => row.callerKey === callerKey && row.operationId === operationId) ?? null,
    retirePreparedAgentLaunch: retire
  }
}

/** Publication never writes, kills or inspects a terminal; those members only satisfy the contract. */
function controllerDouble(members: Partial<RuntimePtyController>): RuntimePtyController {
  return {
    write: () => false,
    kill: () => false,
    getForegroundProcess: async () => null,
    ...members
  }
}

vi.mock('../../../agent-hooks/managed-hook-owner-identity', async (importOriginal) => {
  const actual = await importOriginal<typeof HostIdentity>()
  return { ...actual, readBootIdentity: vi.fn(actual.readBootIdentity) }
})
vi.mock(
  '../../../daemon/prepared-setup-status',
  () => import('../../../daemon/prepared-setup-status-test-harness')
)
vi.mock('../../../daemon/daemon-process-inspection', async (importOriginal) => {
  const actual = await importOriginal<typeof ProcessInspection>()
  return {
    ...actual,
    queryWindowsProcess: vi.fn(actual.queryWindowsProcess),
    readLinuxStat: vi.fn(actual.readLinuxStat),
    readMacosProcessStartedAtMs: vi.fn(actual.readMacosProcessStartedAtMs)
  }
})
const processProbes = () =>
  [queryWindowsProcess, readLinuxStat, readMacosProcessStartedAtMs].reduce(
    (count, probe) => count + vi.mocked(probe).mock.calls.length,
    0
  )

const NOW = 1_800_000_000_000
const PROMPTS = { followup: { agent: 'codex' as const, prompt: 'full guarded prompt' } }
const UNCERTAIN =
  'Codex started, but its first prompt may not have been delivered. Check Codex before sending the prompt again.'
afterEach(() => vi.useRealTimers())

async function fixture(
  withSetup = false,
  accepted: {
    env?: Record<string, string>
    publication?: { launchConfig?: SleepingAgentLaunchConfig; viewMode?: 'terminal' | 'chat' }
    launchTokenHash?: string
  } = {},
  /** Who holds the post-start prompt: this main's creator flow, or a main that has since restarted. */
  prompt: 'creator' | 'restarted' = 'creator'
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
  const setupLines: string[] = []
  const listProcesses = vi.fn(async () => [])
  const owner = new PreparedAgentLaunchOwner({
    owners: new ClaimedAgentPtyOwnerRegistry(),
    create,
    isAlive: () => true,
    reserveCapacity: () => () => {},
    setupSession: (id) =>
      id === 'setup'
        ? {
            isAlive: true,
            incarnationId: incarnations.setup,
            terminalHandle: 'term_setup',
            paneKey: `${surfaces.setup.tabId}:${surfaces.setup.leafId}`,
            startupIngress: { accept: (data: string) => setupLines.push(data) }
          }
        : undefined
  })
  const payload = {
    launch: {
      sessionId: 'agent',
      cols: 80,
      rows: 24,
      command: 'cx',
      ...(accepted.env ? { env: accepted.env } : {})
    },
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
    operationId: `${NOW}-${randomUUID().replaceAll('-', '')}`,
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
  const deliver = vi.fn(async (): Promise<boolean> => true)
  const promptOwnerRef =
    prompt === 'creator'
      ? installPreparedPromptContinuation(prepared, 'codex', PROMPTS, deliver)
      : 'previous-main'
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
      : {}),
    promptOwnerRef
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
  // Like the store, only the call that removes the descriptor reports it and saves the answer.
  const retire = vi.fn(async (args: { outcome?: AgentSessionOperationOutcome }) => {
    if (!('preparedLaunch' in row)) {
      return false
    }
    Reflect.deleteProperty(row, 'preparedLaunch')
    if (args.outcome) {
      row.outcome = args.outcome
    }
    return true
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
    controller: controllerDouble({
      preparedAgentLaunch: (request) => owner.handle(request),
      // Recovery reads the owner's own Setup; a host inventory is never needed.
      listProcesses
    }),
    store: storeOf([row], retire),
    createTerminal,
    placePrimary: vi.fn(async () => {}),
    setTabColor: vi.fn(async () => {}),
    notifyLaunchNotice: vi.fn()
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
    deliver,
    setupLines,
    listProcesses,
    observer: () => observer!,
    zero: () => reportSetupStatus(0, attemptId)
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
    expect(f.deliver).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ handle: 'term_agent' }),
      PROMPTS
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
    expect(f.listProcesses).not.toHaveBeenCalled()
  })

  it.each([1, 10])(
    'recovers %i known Setups in one pass without reading any host inventory',
    async (count) => {
      const launches = await Promise.all(Array.from({ length: count }, () => fixture(true)))
      const byOperation = new Map(launches.map((launch) => [launch.identity.operationId, launch]))
      const listProcesses = vi.fn(async () => [])
      const createTerminal = vi.fn<PreparedPublicationPorts['createTerminal']>(async () => ({
        handle: 'term_setup',
        worktreeId: 'wt',
        title: null
      }))
      const ports: PreparedPublicationPorts = {
        ...launches[0]!.ports,
        controller: controllerDouble({
          preparedAgentLaunch: (request) =>
            byOperation
              .get('identity' in request ? request.identity.operationId : '')!
              .owner.handle(request),
          listProcesses
        }),
        store: storeOf(
          launches.flatMap((launch) => launch.ports.store.listOperationRows()),
          vi.fn(async () => true)
        ),
        createTerminal
      }
      void reconcilePreparedTerminalPublications(ports)
      await vi.advanceTimersByTimeAsync(0)
      // Each launch's owner names its live Setup; no host, related or not, is inventoried.
      expect(listProcesses).not.toHaveBeenCalled()
      expect(createTerminal).toHaveBeenCalledTimes(count)
      for (const [, options] of createTerminal.mock.calls) {
        expect(options).toMatchObject({ sessionId: 'setup', attachOnly: true })
      }
    }
  )

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
    // The window-owned layout gets the same placement on the agent's reveal, never Setup's.
    expect(f.createTerminal.mock.calls.map(([, options]) => options.placeNewTab)).toEqual([
      undefined,
      true
    ])
    // Only Setup's reveal says its workspace waits for an agent still to come.
    expect(f.createTerminal.mock.calls.map(([, options]) => options.preparedLaunchSetup)).toEqual([
      true,
      undefined
    ])
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

  it.each([
    ['written', true, undefined],
    ['refused', false, UNCERTAIN]
  ] as const)(
    'writes once across overlapping controllers and replays the saved %s answer to a delayed one',
    async (_case, written, warning) => {
      const f = await fixture()
      f.deliver.mockResolvedValueOnce(written)
      const handle = f.ports.controller.preparedAgentLaunch!
      const held = Promise.withResolvers<void>()
      // An old connection publishes too, but its reply is held until after the creator has
      // written, saved its answer and retired the launch.
      const old: PreparedPublicationPorts = {
        ...f.ports,
        controller: {
          ...f.ports.controller,
          preparedAgentLaunch: async (request) => {
            const reply = await handle(request)
            if (request.action === 'ackPublication') {
              await held.promise
            }
            return reply
          }
        }
      }
      const delayed = publishPreparedTerminal(f.identity, f.descriptor, old)
      await vi.advanceTimersByTimeAsync(0)
      const current = await publishPreparedTerminal(f.identity, f.descriptor, f.ports)
      expect(current?.warning).toBe(warning)
      expect(f.retire).toHaveBeenCalledOnce()
      held.resolve()
      // The saved answer, not this observer's own inference, is what it returns.
      expect((await delayed)?.warning).toBe(warning)
      // So does a later publication from a stale descriptor.
      expect((await publishPreparedTerminal(f.identity, f.descriptor, old))?.warning).toBe(warning)
      expect(f.deliver).toHaveBeenCalledOnce()
      expect(f.ports.notifyLaunchNotice).toHaveBeenCalledTimes(warning ? 1 : 0)
      expect(f.owner.pending).toBe(0)
    }
  )

  it('retries only the recording of a written prompt whose answer could not be saved', async () => {
    const f = await fixture()
    f.retire.mockRejectedValueOnce(new Error('store write failed'))
    // The user's terminal and answer do not wait for bookkeeping.
    expect(await publishPreparedTerminal(f.identity, f.descriptor, f.ports)).toMatchObject({
      handle: 'term_agent'
    })
    await reconcilePreparedTerminalPublications(f.ports)
    await reconcilePreparedTerminalPublications(f.ports)
    expect(f.deliver).toHaveBeenCalledOnce()
    expect(f.retire).toHaveBeenCalledTimes(2)
    expect(f.retire).toHaveBeenLastCalledWith(
      expect.objectContaining({
        outcome: expect.objectContaining({
          launch: expect.not.objectContaining({ warning: UNCERTAIN })
        })
      })
    )
    expect(f.ports.notifyLaunchNotice).not.toHaveBeenCalled()
  })

  it('after a main restart, reports a prompt-bearing launch once as uncertain and never writes', async () => {
    const f = await fixture(false, {}, 'restarted')
    await reconcilePreparedTerminalPublications(f.ports)
    await reconcilePreparedTerminalPublications(f.ports)
    expect(f.createTerminal).toHaveBeenCalledOnce()
    expect(f.deliver).not.toHaveBeenCalled()
    expect(f.retire).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        outcome: expect.objectContaining({
          launch: expect.objectContaining({ warning: UNCERTAIN })
        })
      })
    )
    expect(f.ports.notifyLaunchNotice).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ operationId: f.identity.operationId, kind: 'prompt-uncertain' })
    )
  })

  it('shows a closed Setup once however many observers saw it', async () => {
    const f = await fixture(true)
    const handle = f.ports.controller.preparedAgentLaunch!
    const old: PreparedPublicationPorts = {
      ...f.ports,
      controller: { ...f.ports.controller, preparedAgentLaunch: (request) => handle(request) }
    }
    const publications = [f.ports, old].map((ports) =>
      publishPreparedTerminal(f.identity, f.descriptor, ports)
    )
    await vi.advanceTimersByTimeAsync(0)
    f.observer().onExit()
    expect(await Promise.all(publications)).toEqual([null, null])
    await reconcilePreparedTerminalPublications(f.ports)
    expect(f.retire).toHaveBeenCalledTimes(2)
    expect(f.ports.notifyLaunchNotice).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ operationId: f.identity.operationId, kind: 'setup-ended' })
    )
  })

  it('launches the agent once when Setup finishes while main is restarting', async () => {
    const f = await fixture(true)
    // No main is connected: the daemon reads Setup's status itself and starts the agent.
    f.zero()
    await vi.advanceTimersByTimeAsync(0)
    expect(f.create).toHaveBeenCalledTimes(2)
    expect(f.createTerminal).not.toHaveBeenCalled()
    // The restarted main rejoins that agent; neither reconnect starts another.
    await reconcilePreparedTerminalPublications(f.ports)
    await reconcilePreparedTerminalPublications(f.ports)
    expect(f.create).toHaveBeenCalledTimes(2)
    // It also rejoins the still-open Setup tab; the agent is published once, attached, never re-run.
    const agentPublications = f.createTerminal.mock.calls.filter(
      ([, options]) => options.sessionId === 'agent'
    )
    expect(agentPublications).toEqual([
      ['id:wt', expect.objectContaining({ attachOnly: true, preparedFirstPublication: true })]
    ])
    expect(f.retire).toHaveBeenCalledOnce()
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
      const generation = formatPreparedLaunchGeneration({ pid: gone.pid!, start: 'exited-daemon' })
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
        return row ? Reflect.deleteProperty(row, 'preparedLaunch') : false
      })
      const probes = vi.fn(async () => {
        throw new Error('agent_session_ownership_unknown')
      })
      const ports: PreparedPublicationPorts = {
        ...f.ports,
        controller: controllerDouble({ preparedAgentLaunch: probes }),
        store: storeOf(rows, retire)
      }
      vi.useRealTimers()
      await reconcilePreparedTerminalPublications(ports)
      await reconcilePreparedTerminalPublications(ports)
      expect(retire).toHaveBeenCalledTimes(count)
      // Each dead owner is asked once; a retired descriptor is never probed again.
      expect(probes).toHaveBeenCalledTimes(count)
    }
  )

  it.each([1, 10])(
    'proves one live but unreachable generation once per pass for %i descriptors',
    async (count) => {
      const f = await fixture()
      vi.useRealTimers()
      const live = await readCurrentPreparedLaunchIncarnation()
      const generation = formatPreparedLaunchGeneration(live)
      const rows = Array.from({ length: count + 1 }, (_, index) => ({
        ...pendingAgentSessionOperationRow({
          callerKey: 'worktree-startup',
          operationId: `${NOW}-${String(index).padStart(32, '0')}`,
          fingerprint: 'fingerprint',
          now: NOW
        }),
        preparedLaunch: { ...f.descriptor, daemonGeneration: generation }
      }))
      const answered = rows[count].operationId
      const retire = vi.fn(async (identity: { operationId: string }) =>
        Reflect.deleteProperty(
          rows.find((row) => row.operationId === identity.operationId)!,
          'preparedLaunch'
        )
      )
      const ports: PreparedPublicationPorts = {
        ...f.ports,
        controller: controllerDouble({
          // One operation is answered by its own generation; the rest cannot reach it.
          preparedAgentLaunch: async (request) => {
            throw new Error(
              'identity' in request && request.identity.operationId === answered
                ? 'agent_session_operation_unknown'
                : 'agent_session_ownership_unknown'
            )
          }
        }),
        store: storeOf(rows, retire)
      }
      for (const pass of [1, 2]) {
        for (const probe of [
          readBootIdentity,
          queryWindowsProcess,
          readLinuxStat,
          readMacosProcessStartedAtMs
        ]) {
          vi.mocked(probe).mockClear()
        }
        await reconcilePreparedTerminalPublications(ports)
        // One boot read and one process probe per pass, however many descriptors share the owner.
        expect(readBootIdentity).toHaveBeenCalledTimes(live.boot ? 1 : 0)
        expect(processProbes()).toBe(1)
        expect(retire, `pass ${pass}`).toHaveBeenCalledTimes(1)
      }
      // That generation's answer retired only its own operation; the live owner keeps the rest.
      expect(retire).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({ operationId: answered })
      )
      expect(rows.filter((row) => 'preparedLaunch' in row)).toHaveLength(count)
    }
  )

  it("keeps a descriptor whose daemon is unreachable but alive, and retires on that generation's answer", async () => {
    const f = await fixture()
    // Recorded while the daemon could not read its boot; reading it now is not another process.
    const { boot: _unknownThen, ...live } = await readCurrentPreparedLaunchIncarnation()
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
    const retire = vi.fn(async () => true)
    const ports: PreparedPublicationPorts = {
      ...f.ports,
      controller: controllerDouble({
        preparedAgentLaunch: async () => {
          throw reply.error
        }
      }),
      store: storeOf(rows, retire)
    }
    vi.useRealTimers()
    await reconcilePreparedTerminalPublications(ports)
    expect(retire).not.toHaveBeenCalled()
    reply.error = new Error('agent_session_operation_unknown')
    await reconcilePreparedTerminalPublications(ports)
    expect(retire).toHaveBeenCalledOnce()
  })
})
