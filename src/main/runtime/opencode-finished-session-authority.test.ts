import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type * as ShellAloneModule from './run-terminal-shell-alone'
import { AgentHookServer } from '../agent-hooks/server'
import { agentHookRuntimeDeps } from '../agent-hooks/agent-hook-runtime-deps'
import { makeStructuredAgentStatusSubject } from '../../shared/agent-status-subject'
import { TerminalSnapshotState } from '../../shared/terminal-snapshot-state'
import { OrcaRuntimeService } from './orca-runtime'
import { makeStore } from './runtime-rpc-worktree-store-fixtures'
import { parsePaneKey } from '../../shared/stable-pane-id'
import { spawnedPtyEnv } from './spawned-pty-env-fixtures'
import { committingSpawn } from './bind-first-pane.test-fixture'

// STA-4557: deferred OpenCode foreground reads retained/revived finished authority (#14866, reverted in #14943).

const WORKTREE_PATH = '/tmp/worktree-a'
const WORKTREE = {
  path: WORKTREE_PATH,
  head: 'abc',
  branch: 'feature/opencode-authority',
  isBare: false,
  isMainWorktree: false
}

// The shell's process tree after OpenCode exits: nothing but the shell.
const presenceProbe = vi.hoisted(() => vi.fn(async () => 'exited' as const))
vi.mock('../../shared/agent-process-presence-probe', () => ({
  probeAgentProcessPresence: presenceProbe
}))
vi.mock('../telemetry/client', () => ({ track: vi.fn() }))
vi.mock('../telemetry/cohort-classifier', () => ({ getCohortAtEmit: () => ({}) }))
const shellAlone = vi.hoisted(() => vi.fn(async () => true))
vi.mock('./run-terminal-shell-alone', async (importOriginal) => ({
  ...(await importOriginal<typeof ShellAloneModule>()),
  confirmRootShellHasNoChildrenFromProcessTable: shellAlone
}))

vi.mock('../git/worktree', () => ({
  listWorktrees: vi.fn().mockResolvedValue([
    {
      path: '/tmp/worktree-a',
      head: 'abc',
      branch: 'feature/opencode-authority',
      isBare: false,
      isMainWorktree: false
    }
  ]),
  listWorktreesStrict: vi.fn().mockResolvedValue([
    {
      path: '/tmp/worktree-a',
      head: 'abc',
      branch: 'feature/opencode-authority',
      isBare: false,
      isMainWorktree: false
    }
  ])
}))

class MeasuredAuthorityServer extends AgentHookServer {
  get measuredStore() {
    return this.canonicalStatusStore
  }
  get measuredSubscribers() {
    return {
      status: this.statusChangeListeners.size,
      provider: this.providerSessionChangeListeners.size
    }
  }
}

function measureAuthority(server: MeasuredAuthorityServer, size: number) {
  for (let i = 0; i < size; i++) {
    const subject = makeStructuredAgentStatusSubject(
      {
        executionHostId: 'local',
        wslDistro: null,
        workspaceId: 'foreign',
        workspaceKind: 'git-worktree'
      },
      `scale-session-${i}`
    )
    server.ingestStructuredStatus(
      {
        sessionId: subject.sessionId,
        workspaceId: 'foreign',
        agent: 'codex',
        status: 'working',
        hostExecutionOwned: true,
        updatedAt: 100
      },
      subject
    )
  }
  const counts = {
    capture: 0,
    applied: 0,
    population: 0,
    probes: 0,
    pointCopies: 0,
    pointLists: 0,
    captureCopies: 0,
    appliedCopies: 0,
    populationCopies: 0,
    otherLists: 0,
    otherCopies: 0,
    mutations: 0,
    keyed: 0
  }
  const otherSources: Record<string, { calls: number; copied: number }> = {}
  let phase = 'other'
  const parents = server.measuredStore.getParents.bind(server.measuredStore)
  vi.spyOn(server.measuredStore, 'getParents').mockImplementation(() => {
    const rows = parents()
    // Attribute the direct production caller, not every listing caused by a D.
    const point = new Error('authority operation caller').stack
      ?.split('\n')
      .find((line) => line.includes('/src/main/agent-hooks/server/'))
      ?.includes('server-authority-fences.ts')
    if (point) {
      counts.pointLists++
      counts.pointCopies += rows.length
      if (phase === 'capture') {
        counts.captureCopies += rows.length
      } else {
        counts.appliedCopies += rows.length
      }
    } else if (phase === 'population') {
      counts.populationCopies += rows.length
    } else {
      counts.otherLists++
      counts.otherCopies += rows.length
      const source =
        new Error('authority operation caller').stack
          ?.split('\n')
          .find((line) => line.includes('/src/main/agent-hooks/server/'))
          ?.trim() ?? 'unknown'
      const entry = (otherSources[source] ??= { calls: 0, copied: 0 })
      entry.calls++
      entry.copied += rows.length
    }
    return rows
  })
  const keyed = server.measuredStore.getCanonicalParent.bind(server.measuredStore)
  vi.spyOn(server.measuredStore, 'getCanonicalParent').mockImplementation((subject) => {
    counts.keyed++
    return keyed(subject)
  })
  const mutate = server.measuredStore.applyMutation.bind(server.measuredStore)
  vi.spyOn(server.measuredStore, 'applyMutation').mockImplementation((mutation) => {
    counts.mutations++
    return mutate(mutation)
  })
  const capture = (paneKey: string) => {
    counts.capture++
    const previous = phase
    phase = 'capture'
    const callback = server.capturePaneAuthorityRetirement(paneKey)
    phase = previous
    return () => {
      counts.applied++
      const previous = phase
      phase = 'applied'
      try {
        callback()
      } finally {
        phase = previous
      }
    }
  }
  const bindings = agentHookRuntimeDeps(server, { read: () => null }, () => ({}))
  return {
    counts,
    otherSources,
    capture,
    bindings: {
      ...bindings,
      captureAgentHookCompatibilityRetirement: capture,
      getAgentProviderSessionSnapshot: () => {
        counts.population++
        const previous = phase
        phase = 'population'
        try {
          return bindings.getAgentProviderSessionSnapshot()
        } finally {
          phase = previous
        }
      },
      checkHookAgentPresence: (paneKey: string, since?: number) => {
        counts.probes++
        return bindings.checkHookAgentPresence(paneKey, since)
      }
    },
    reset: () => {
      for (const key of Object.keys(counts)) {
        Reflect.set(counts, key, 0)
      }
      for (const key of Object.keys(otherSources)) {
        delete otherSources[key]
      }
    }
  }
}

type LaunchedOpenCodePane = {
  runtime: OrcaRuntimeService
  ptyId: string
  paneKey: string
  tabId: string
  launchToken: string
  evidence: { terminalHandle: string; paneKey: string; launchToken: string }
}

async function launchOpenCodePane(options: {
  ptyId: string
  deps?: OrcaRuntimeServiceDeps
  getForegroundProcess: () => Promise<string | null>
  captureAgentHookCompatibilityRetirement?: OrcaRuntimeServiceDeps['captureAgentHookCompatibilityRetirement']
  retireAgentHookCompatibilityAuthority?: (paneKey: string) => void
  attestAgentHookCompatibilityAuthority?: OrcaRuntimeServiceDeps['attestAgentHookCompatibilityAuthority']
}): Promise<LaunchedOpenCodePane> {
  const spawn = vi.fn(async (_args: { worktreeId?: string; tabId?: string; leafId?: string }) => ({
    id: options.ptyId,
    incarnationId: 'incarnation-1'
  }))
  const runtime = new OrcaRuntimeService(makeStore() as never, undefined, {
    captureAgentHookCompatibilityRetirement: options.captureAgentHookCompatibilityRetirement,
    attestAgentHookCompatibilityAuthority:
      options.attestAgentHookCompatibilityAuthority ??
      ((candidate) => ({ paneKey: candidate.paneKey, source: 'current_hook' as const })),
    ...(options.retireAgentHookCompatibilityAuthority
      ? { retireAgentHookCompatibilityAuthority: options.retireAgentHookCompatibilityAuthority }
      : {}),
    ...options.deps
  })
  runtime.setPtyController({
    spawn: committingSpawn(runtime, spawn),
    write: () => true,
    kill: () => true,
    getForegroundProcess: options.getForegroundProcess,
    listProcesses: async () => [
      { id: options.ptyId, rootProcessId: 4242, cwd: WORKTREE.path, title: 'zsh' }
    ]
  })
  const terminal = await runtime.createTerminal(`path:${WORKTREE.path}`, {
    command: 'opencode',
    launchConfig: { agentCommand: 'opencode', agentArgs: '', agentEnv: {} },
    launchAgent: 'opencode'
  })
  const env = spawnedPtyEnv(spawn.mock.calls[0]?.[0])
  const paneKey = env.ORCA_PANE_KEY
  const launchToken = env.ORCA_AGENT_LAUNCH_TOKEN
  expect(paneKey).toBeTruthy()
  expect(launchToken).toBeTruthy()
  return {
    runtime,
    ptyId: options.ptyId,
    paneKey,
    tabId: paneKey.split(':')[0]!,
    launchToken,
    evidence: { terminalHandle: terminal.handle, paneKey, launchToken }
  }
}

function postOpenCodeHook(
  server: AgentHookServer,
  pane: LaunchedOpenCodePane,
  payload: Record<string, unknown>,
  token = pane.launchToken
): Promise<Response> {
  const hookEnv = server.buildPtyEnv()
  return fetch(`http://127.0.0.1:${hookEnv.ORCA_AGENT_HOOK_PORT}/hook/opencode`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Orca-Agent-Hook-Token': hookEnv.ORCA_AGENT_HOOK_TOKEN
    },
    body: JSON.stringify({
      paneKey: pane.paneKey,
      launchToken: token,
      tabId: pane.tabId,
      worktreeId: pane.runtime.getOrchestrationDispatchAuthority(pane.evidence.terminalHandle)
        ?.worktreeId,
      env: 'production',
      payload
    })
  })
}

function attestOpenCode(
  server: AgentHookServer,
  pane: LaunchedOpenCodePane,
  token: string,
  terminalProvenance: 'current_runtime' | 'restored'
) {
  return server.attestCompatibilityAuthority({
    paneKey: pane.paneKey,
    launchTokenHash: createHash('sha256').update(token).digest('hex'),
    connectionId: null,
    terminalProvenance
  })
}

function connectAuthority(server: AgentHookServer, runtime: OrcaRuntimeService): void {
  server.setLaunchAuthorityVerifier(
    (candidate, handle) => runtime.verifyAgentHookLaunchAuthority(candidate, handle),
    (listener) => runtime.subscribeAgentLaunchAuthority(listener)
  )
}

type OrcaRuntimeServiceDeps = NonNullable<ConstructorParameters<typeof OrcaRuntimeService>[2]>

async function settle(ticks = 40): Promise<void> {
  for (let tick = 0; tick < ticks; tick += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0))
  }
}

describe('OpenCode finished-session launch authority (STA-4557)', () => {
  const servers: AgentHookServer[] = []
  const tempDirs: string[] = []

  afterEach(() => {
    for (const server of servers) {
      server.stop()
    }
    servers.length = 0
    for (const dir of tempDirs) {
      rmSync(dir, { recursive: true, force: true })
    }
    tempDirs.length = 0
    vi.restoreAllMocks()
  })

  it('keeps ordinary-shell D capture independent of population while real presence reconciles, including raw and capable ingress', async () => {
    const measurements = []
    for (const size of [10, 100]) {
      const server = new MeasuredAuthorityServer()
      servers.push(server)
      await server.start({ env: 'production' })
      const m = measureAuthority(server, size)
      const facts: string[] = []
      const runtime = new OrcaRuntimeService(undefined, undefined, {
        ...m.bindings,
        onTerminalSideEffects: (batch) => facts.push(...batch.facts.map((fact) => fact.kind))
      })
      const leafId = '11111111-1111-4111-8111-111111111111'
      const paneKey = `shell:${leafId}`
      runtime.attachWindow(1)
      runtime.syncWindowGraph(1, {
        tabs: [
          {
            tabId: 'shell',
            worktreeId: 'workspace',
            title: 'Terminal',
            activeLeafId: leafId,
            layout: null
          }
        ],
        leaves: [
          { tabId: 'shell', worktreeId: 'workspace', leafId, paneRuntimeId: 1, ptyId: 'pty-shell' }
        ]
      })
      const pty = Reflect.get(runtime, 'ptysById').get('pty-shell')
      expect(pty.launchToken).toBeFalsy()
      expect(pty.launchAgent).toBeFalsy()
      expect(Reflect.get(runtime, 'restoredOrchestrationAuthorityByPtyId').has('pty-shell')).toBe(
        false
      )
      server.ingestRemote(
        {
          paneKey,
          worktreeId: 'workspace',
          providerSession: { key: 'session_id', id: 'manual' },
          agentPresence: {
            agent: 'codex',
            process: { pid: 4242, platform: 'linux', startTime: 'birth' }
          },
          payload: { state: 'working', prompt: '', agentType: 'codex' }
        },
        null
      )
      expect(server.getStatusSnapshotForPane(paneKey)[0]?.state).toBe('working')
      m.reset()
      presenceProbe.mockClear()
      facts.length = 0
      for (let d = 0; d < 10; d++) {
        runtime.emitDaemonPtyTransientFact('pty-shell', { kind: 'command-finished', exitCode: 0 })
      }
      await settle()
      expect(facts.filter((fact) => fact === 'command-finished')).toHaveLength(10)
      expect(m.counts.capture).toBe(10)
      expect(m.counts.applied).toBe(0)
      expect(m.counts.population).toBe(10)
      expect(m.counts.probes).toBe(10)
      expect(presenceProbe).toHaveBeenCalledTimes(1)
      expect(server.getStatusSnapshotForPane(paneKey)[0]).toMatchObject({
        providerSessionOnly: true
      })
      expect(
        server._getStateForTests().lastStatusByPaneKey.get(paneKey)?.agentPresence?.ended
      ).toBe(true)
      expect(server.hasVerifiableAgentProcess(paneKey)).toBe(false)
      measurements.push({
        size,
        d: 10,
        ...m.counts,
        otherSources: structuredClone(m.otherSources),
        subscribers: server.measuredSubscribers
      })
      // Raw D reaches the same boundary; capable baseline is outside its D window.
      m.reset()
      runtime.onPtyData('pty-shell', '\x1b]133;D;0\x07\x1b]133;A\x07', 100)
      expect(m.counts.capture).toBe(1)
      const source = new TerminalSnapshotState()
      const capable = { provider: {}, stream: {}, terminalState: true }
      runtime.applyTerminalTransientObservation('pty-shell', 'physical', source.snapshot(), capable)
      expect(m.counts.capture).toBe(1)
      m.reset()
      source.record({ kind: 'command-started' }, 101)
      runtime.applyTerminalTransientObservation('pty-shell', 'physical', source.snapshot(), capable)
      source.record({ kind: 'command-finished', exitCode: 0 }, 102)
      const finished = source.snapshot()
      runtime.applyTerminalTransientObservation('pty-shell', 'physical', finished, capable)
      expect(m.counts.capture).toBe(1)
      runtime.applyTerminalTransientObservation('pty-shell', 'physical', finished, capable)
      runtime.applyTerminalTransientObservation(
        'pty-shell',
        'physical',
        { ...finished, revision: finished.revision - 1 },
        capable
      )
      expect(m.counts.capture).toBe(1)
      source.record({ kind: 'command-finished', exitCode: 0 }, 103)
      source.record({ kind: 'command-started' }, 104)
      runtime.applyTerminalTransientObservation('pty-shell', 'physical', source.snapshot(), capable)
      expect(m.counts.capture).toBe(1)
      await settle()
    }
    console.log('ORDINARY_AUTHORITY_COUNTS', JSON.stringify(measurements))
    expect(measurements.map((m) => m.pointCopies)).toEqual([0, 0])
  })

  it('settles live, unproven and failed proofs, rejects physical changes, and allows a genuine later proof', async () => {
    for (const mode of [
      'live',
      'unproven',
      'error',
      'incarnation',
      'token',
      'agent',
      'receipt',
      'generation',
      'replacement',
      'current'
    ] as const) {
      const server = new AgentHookServer()
      servers.push(server)
      await server.start({ env: 'production' })
      let release!: (value: 'live' | 'exited' | 'unverifiable' | null) => void
      const presence = new Promise<'live' | 'exited' | 'unverifiable' | null>((resolve) => {
        release = resolve
      })
      const callbacks = vi.fn()
      const check = vi.fn(() => presence)
      const capture = vi.fn((key: string) => {
        const captured = server.capturePaneAuthorityRetirement(key)
        return () => {
          callbacks()
          captured()
        }
      })
      const pane = await launchOpenCodePane({
        ptyId: `pty-proof-${mode}`,
        getForegroundProcess: async () => 'opencode',
        deps: { checkHookAgentPresence: check, captureAgentHookCompatibilityRetirement: capture }
      })
      server.ingestRemote(
        {
          paneKey: pane.paneKey,
          worktreeId: pane.runtime.getOrchestrationDispatchAuthority(pane.evidence.terminalHandle)!
            .worktreeId,
          providerSession: { key: 'session_id', id: mode },
          payload: { state: 'working', prompt: '', agentType: 'opencode' }
        },
        null
      )
      const ptys = Reflect.get(pane.runtime, 'ptysById')
      const original = ptys.get(pane.ptyId)
      const receipts = Reflect.get(pane.runtime, 'restoredOrchestrationAuthorityByPtyId')
      shellAlone.mockClear()
      if (mode === 'unproven') {
        shellAlone.mockResolvedValueOnce(false)
      }
      if (mode === 'error') {
        shellAlone.mockRejectedValueOnce(new Error('inspection unavailable'))
      }
      pane.runtime.emitDaemonPtyTransientFact(pane.ptyId, { kind: 'command-finished', exitCode: 0 })
      expect(capture).toHaveBeenCalledTimes(1)
      expect(check).toHaveBeenCalledTimes(1)
      expect(capture.mock.invocationCallOrder[0]).toBeLessThan(check.mock.invocationCallOrder[0]!)
      pane.runtime.emitDaemonPtyTransientFact(pane.ptyId, { kind: 'command-finished', exitCode: 0 })
      expect(capture).toHaveBeenCalledTimes(1)
      if (mode === 'incarnation') {
        original.incarnationId = 'replacement'
      }
      if (mode === 'token') {
        original.launchToken = 'successor'
      }
      if (mode === 'agent') {
        original.launchAgent = 'codex'
      }
      if (mode === 'receipt') {
        receipts.set(pane.ptyId, { paneKey: pane.paneKey })
      }
      if (mode === 'generation') {
        Reflect.get(pane.runtime, 'advancePtyLifecycleGeneration').call(pane.runtime, pane.ptyId)
      }
      if (mode === 'replacement') {
        ptys.delete(pane.ptyId)
        pane.runtime.registerPty(pane.ptyId, original.worktreeId, null, {
          ...parsePaneKey(pane.paneKey)!,
          incarnationId: 'replacement'
        })
        expect(ptys.get(pane.ptyId)).not.toBe(original)
      }
      release(
        mode === 'live'
          ? 'live'
          : mode === 'unproven' || mode === 'error'
            ? 'unverifiable'
            : 'exited'
      )
      await settle(6)
      expect(callbacks).toHaveBeenCalledTimes(mode === 'current' ? 1 : 0)
      if (mode !== 'current') {
        expect(server.getStatusSnapshotForPane(pane.paneKey)[0]?.state).toBe('working')
      }
      if (mode === 'live' || mode === 'unproven' || mode === 'error') {
        check.mockResolvedValueOnce('exited')
        pane.runtime.emitDaemonPtyTransientFact(pane.ptyId, {
          kind: 'command-finished',
          exitCode: 0
        })
        await settle(6)
        expect(check).toHaveBeenCalledTimes(2)
        expect(callbacks).toHaveBeenCalledTimes(1)
        expect(server.getStatusSnapshotForPane(pane.paneKey)).toEqual([])
      }
      server.stop()
    }
  })

  it('captures a receipt-only address before cleanup and retains direct certified-exit retirement', async () => {
    const server = new AgentHookServer()
    servers.push(server)
    await server.start({ env: 'production' })
    const receiptPane = 'receipt:22222222-2222-4222-8222-222222222222'
    const capture = vi.fn((key: string) => server.capturePaneAuthorityRetirement(key))
    const retire = vi.spyOn(server, 'retirePaneAuthority')
    const pane = await launchOpenCodePane({
      ptyId: 'pty-receipt',
      getForegroundProcess: async () => 'zsh',
      deps: {
        checkHookAgentPresence: async () => 'exited',
        captureAgentHookCompatibilityRetirement: capture,
        retireAgentHookCompatibilityAuthority: (key) => server.retirePaneAuthority(key)
      }
    })
    const pty = Reflect.get(pane.runtime, 'ptysById').get(pane.ptyId)
    pty.launchToken = null
    pty.launchAgent = null
    const receipts = Reflect.get(pane.runtime, 'restoredOrchestrationAuthorityByPtyId')
    receipts.set(
      pane.ptyId,
      Object.freeze({
        ptyId: pane.ptyId,
        worktreeId: pty.worktreeId,
        terminalHandle: pane.evidence.terminalHandle,
        paneKey: receiptPane,
        processIncarnation: 'incarnation-1',
        hostScope: { kind: 'local', hostId: 'local' }
      })
    )
    server.ingestRemote(
      {
        paneKey: receiptPane,
        worktreeId: pty.worktreeId,
        providerSession: { key: 'session_id', id: 'restored' },
        payload: { state: 'working', prompt: '', agentType: 'opencode' }
      },
      null
    )
    pane.runtime.emitDaemonPtyTransientFact(pane.ptyId, { kind: 'command-finished', exitCode: 0 })
    await settle(6)
    expect(capture).toHaveBeenCalledWith(receiptPane)
    expect(retire).toHaveBeenCalledWith(receiptPane)
    expect(receipts.has(pane.ptyId)).toBe(false)
    expect(server.getStatusSnapshotForPane(receiptPane)).toEqual([])
    // Direct physical exit remains separate from completion proof and reaches the same actual server cleanup.
    const direct = await launchOpenCodePane({
      ptyId: 'pty-certified-exit',
      getForegroundProcess: async () => 'opencode',
      retireAgentHookCompatibilityAuthority: (key) => server.retirePaneAuthority(key)
    })
    server.ingestRemote(
      {
        paneKey: direct.paneKey,
        worktreeId: pty.worktreeId,
        payload: { state: 'working', prompt: '', agentType: 'opencode' }
      },
      null
    )
    await direct.runtime.onPtyExit(direct.ptyId, 0, 'incarnation-1', { providerExitObserved: true })
    expect(server.getStatusSnapshotForPane(direct.paneKey)).toEqual([])
  })

  it('retires authority when command-finished proves OpenCode left the foreground, even if a title raced the read', async () => {
    let resolveForeground: ((process: string | null) => void) | undefined
    const foreground = new Promise<string | null>((resolve) => {
      resolveForeground = resolve
    })
    const getForegroundProcess = vi.fn(() => foreground)
    const pane = await launchOpenCodePane({
      ptyId: 'pty-opencode-exit',
      getForegroundProcess
    })

    expect(pane.runtime.verifyOrchestrationCompatibilityCaller(pane.evidence)).not.toBeNull()

    // OpenCode exits; the shell prints its OSC 133;D and repaints its title while the
    // foreground read is still in flight, then the read lands proving a plain shell.
    pane.runtime.onPtyData(pane.ptyId, '\x1b]133;D;0\x07\x1b]133;A\x07', 100)
    pane.runtime.onPtyData(pane.ptyId, '\x1b]0;~/worktree-a\x07', 101)
    resolveForeground?.('zsh')
    await settle()

    expect(pane.runtime.verifyOrchestrationCompatibilityCaller(pane.evidence)).toBeNull()
  })

  it('retires authority when every foreground re-poll keeps racing a fresh title', async () => {
    let titleSequence = 0
    const getForegroundProcess = vi.fn(
      () =>
        new Promise<string | null>((resolve) => {
          setTimeout(() => {
            titleSequence += 1
            pane.runtime.onPtyData(
              pane.ptyId,
              `\x1b]0;~/worktree-a (${titleSequence})\x07`,
              200 + titleSequence
            )
            resolve('zsh')
          }, 0)
        })
    )
    const pane = await launchOpenCodePane({
      ptyId: 'pty-opencode-title-storm',
      getForegroundProcess
    })

    pane.runtime.onPtyData(pane.ptyId, '\x1b]133;D;0\x07\x1b]133;A\x07', 100)
    await settle()

    expect(pane.runtime.verifyOrchestrationCompatibilityCaller(pane.evidence)).toBeNull()
  })

  it('stops attesting the finished session token for the reused pane', async () => {
    const server = new MeasuredAuthorityServer()
    servers.push(server)
    await server.start({ env: 'production' })
    const pane = await launchOpenCodePane({
      ptyId: 'pty-opencode-reuse',
      // OpenCode remains foreground when an internal TUI command completes.
      getForegroundProcess: async () => 'opencode',
      retireAgentHookCompatibilityAuthority: (paneKey) => server.retirePaneAuthority(paneKey),
      attestAgentHookCompatibilityAuthority: (candidate) =>
        server.attestCompatibilityAuthority(candidate)
    })
    connectAuthority(server, pane.runtime)
    const post = (payload: Record<string, unknown>) => postOpenCodeHook(server, pane, payload)

    await post({ hook_event_name: 'SessionStart', sessionID: 'session-1' })
    await post({ hook_event_name: 'SessionBusy', sessionID: 'session-1' })
    expect(attestOpenCode(server, pane, pane.launchToken, 'current_runtime')).not.toBeNull()

    pane.runtime.onPtyData(pane.ptyId, '\x1b]133;D;0\x07\x1b]133;A\x07', 100)
    await settle()

    // Every later shell child inherits the launch token; finished sessions must stop attesting it.
    expect(attestOpenCode(server, pane, pane.launchToken, 'current_runtime')).toBeNull()
  })

  it.each([10, 100])(
    'does not let a later OpenCode session satisfy the previous pending retirement (C=%s)',
    async (size) => {
      const userDataPath = mkdtempSync(join(tmpdir(), 'orca-sta4557-successor-'))
      tempDirs.push(userDataPath)
      let server = new MeasuredAuthorityServer()
      servers.push(server)
      await server.start({ env: 'production', userDataPath })
      const measurement = measureAuthority(server, size)
      let resolveForeground: ((process: string | null) => void) | undefined
      const foreground = new Promise<string | null>((resolve) => {
        resolveForeground = resolve
      })
      let resolveCensus: ((alone: boolean) => void) | undefined
      const census = new Promise<boolean>((resolve) => {
        resolveCensus = resolve
      })
      shellAlone.mockClear().mockReturnValueOnce(census)
      const pane = await launchOpenCodePane({
        ptyId: 'pty-opencode-session-boundary',
        getForegroundProcess: () => foreground,
        captureAgentHookCompatibilityRetirement: measurement.capture,
        retireAgentHookCompatibilityAuthority: (paneKey) => server.retirePaneAuthority(paneKey),
        attestAgentHookCompatibilityAuthority: (candidate) =>
          server.attestCompatibilityAuthority(candidate)
      })
      // Each process in this shell inherits the token; only the session separates them.
      const post = (sessionId: string, hookEvent = 'SessionBusy', token = pane.launchToken) =>
        postOpenCodeHook(server, pane, { hook_event_name: hookEvent, sessionID: sessionId }, token)
      const attestCurrent = (): unknown =>
        attestOpenCode(server, pane, pane.launchToken, 'current_runtime')

      await post('session-1')
      expect(attestCurrent()).toBeNull()
      // The one-shot hook precedes verifier installation, then qualifies against the real launch.
      connectAuthority(server, pane.runtime)
      expect(attestCurrent()).not.toBeNull()

      measurement.reset()
      // Session 1 ends. Nothing about the PTY changes across an agent session boundary:
      // same record, same incarnation, no title write — so every guard on the deferred
      // read still matches the baseline captured for session 1.
      pane.runtime.onPtyData(pane.ptyId, '\x1b]133;D;0\x07\x1b]133;A\x07', 100)
      await vi.waitFor(() => expect(shellAlone).toHaveBeenCalledTimes(1))
      pane.runtime.emitDaemonPtyTransientFact(pane.ptyId, { kind: 'command-finished', exitCode: 0 })
      await post('session-2')
      resolveCensus?.(true)
      resolveForeground?.('opencode')
      await settle()

      console.log(
        'HELD_AUTHORITY_COUNTS',
        JSON.stringify({
          size,
          ...measurement.counts,
          otherSources: measurement.otherSources,
          subscribers: server.measuredSubscribers
        })
      )
      expect(measurement.counts.capture).toBe(1)
      expect(measurement.counts.applied).toBe(1)
      const heldPointCopies = measurement.counts.pointCopies
      expect(shellAlone).toHaveBeenCalledTimes(1)
      expect(attestCurrent()).toBeNull()
      const successor = () => server.getStatusSnapshotForPane(pane.paneKey)[0]
      expect(successor()?.providerSession?.id).toBe('session-2')
      await post('session-2')
      expect(successor()?.state).toBe('working')
      expect(attestCurrent()).toBeNull()
      await post('session-2', 'SessionStart')
      expect(attestCurrent()).toBeNull()
      server.flushStatusPersistSync()
      const saved = readFileSync(join(userDataPath, 'agent-hooks', 'last-status.json'), 'utf8')
      expect(saved).not.toContain(pane.launchToken)
      expect(saved).not.toContain(createHash('sha256').update(pane.launchToken).digest('hex'))
      server.stop()
      const spoolDir = join(userDataPath, 'agent-hooks', 'spool')
      mkdirSync(spoolDir, { recursive: true })
      writeFileSync(
        join(spoolDir, 'successor.jsonl'),
        `${JSON.stringify({
          paneKey: pane.paneKey,
          tabId: pane.tabId,
          source: 'opencode',
          env: 'production',
          launchToken: pane.launchToken,
          receivedAt: Date.now(),
          worktreeId: pane.runtime.getOrchestrationDispatchAuthority(pane.evidence.terminalHandle)
            ?.worktreeId,
          payload: { hook_event_name: 'SessionBusy', sessionID: 'session-2' }
        })}\n`
      )
      server = new MeasuredAuthorityServer()
      servers.push(server)
      await server.start({ env: 'production', userDataPath })
      connectAuthority(server, pane.runtime)
      expect(successor()?.providerSession?.id).toBe('session-2')
      await post('session-2')
      expect(successor()?.state).toBe('working')
      expect(attestCurrent()).toBeNull()
      expect(attestOpenCode(server, pane, pane.launchToken, 'restored')).toBeNull()
      server.dropStatusEntry(pane.paneKey, { preserveResumeIdentity: false })
      await post('session-2')
      expect(successor()?.state).toBe('working')
      expect(attestCurrent()).toBeNull()
      const binding = parsePaneKey(pane.paneKey)!
      const freshToken = 'fresh-independent-launch'
      pane.runtime.registerPty(
        pane.ptyId,
        pane.runtime.getOrchestrationDispatchAuthority(pane.evidence.terminalHandle)!.worktreeId,
        null,
        {
          ...binding,
          incarnationId: 'incarnation-1',
          agentLaunchAuthority: { launchToken: freshToken, launchAgent: 'opencode' }
        }
      )
      await post('session-3', 'SessionBusy', freshToken)
      expect(attestOpenCode(server, pane, freshToken, 'current_runtime')).not.toBeNull()
      expect(attestCurrent()).toBeNull()
      expect(heldPointCopies).toBe(0)
    }
  )
  it('does not rehydrate a finished session token as restored authority after a restart', async () => {
    const userDataPath = mkdtempSync(join(tmpdir(), 'orca-sta4557-'))
    tempDirs.push(userDataPath)
    const first = new AgentHookServer()
    servers.push(first)
    await first.start({ env: 'production', userDataPath })
    const pane = await launchOpenCodePane({
      ptyId: 'pty-opencode-restart',
      getForegroundProcess: async () => 'opencode',
      retireAgentHookCompatibilityAuthority: (paneKey) => first.retirePaneAuthority(paneKey)
    })
    connectAuthority(first, pane.runtime)
    await postOpenCodeHook(first, pane, { hook_event_name: 'SessionStart', sessionID: 'session-1' })

    pane.runtime.onPtyData(pane.ptyId, '\x1b]133;D;0\x07\x1b]133;A\x07', 100)
    await settle()
    first.flushStatusPersistSync()
    first.stop()

    const restarted = new AgentHookServer()
    servers.push(restarted)
    await restarted.start({ env: 'production', userDataPath })

    // Restart retains token in PTY env but loses pty.launchToken; persisted commitment is the only authority proof.
    expect(attestOpenCode(restarted, pane, pane.launchToken, 'restored')).toBeNull()
  })
})
