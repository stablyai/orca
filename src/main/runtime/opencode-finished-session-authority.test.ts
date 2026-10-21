import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type * as ShellAloneModule from './run-terminal-shell-alone'
import { AgentHookServer } from '../agent-hooks/server'
import { OrcaRuntimeService } from './orca-runtime'
import { makeStore } from './runtime-rpc-worktree-store-fixtures'
import { parsePaneKey } from '../../shared/stable-pane-id'
import { spawnedPtyEnv } from './spawned-pty-env-fixtures'

// STA-4557: #14866 deferred command-finished retirement for OpenCode panes behind an
// async "is the foreground still OpenCode?" read. These pin the two ways a finished
// session then kept or regained orchestration authority (the #14943 revert reason).

const WORKTREE_PATH = '/tmp/worktree-a'
const WORKTREE = {
  path: WORKTREE_PATH,
  head: 'abc',
  branch: 'feature/opencode-authority',
  isBare: false,
  isMainWorktree: false
}

// The shell's process tree after OpenCode exits: nothing but the shell.
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
  getForegroundProcess: () => Promise<string | null>
  captureAgentHookCompatibilityRetirement?: OrcaRuntimeServiceDeps['captureAgentHookCompatibilityRetirement']
  retireAgentHookCompatibilityAuthority?: (paneKey: string) => void
  attestAgentHookCompatibilityAuthority?: OrcaRuntimeServiceDeps['attestAgentHookCompatibilityAuthority']
}): Promise<LaunchedOpenCodePane> {
  const spawn = vi.fn().mockResolvedValue({ id: options.ptyId, incarnationId: 'incarnation-1' })
  const runtime = new OrcaRuntimeService(makeStore() as never, undefined, {
    captureAgentHookCompatibilityRetirement: options.captureAgentHookCompatibilityRetirement,
    attestAgentHookCompatibilityAuthority:
      options.attestAgentHookCompatibilityAuthority ??
      ((candidate) => ({ paneKey: candidate.paneKey, source: 'current_hook' as const })),
    ...(options.retireAgentHookCompatibilityAuthority
      ? { retireAgentHookCompatibilityAuthority: options.retireAgentHookCompatibilityAuthority }
      : {})
  })
  runtime.setPtyController({
    spawn,
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

function connectAuthority(server: AgentHookServer, runtime: OrcaRuntimeService): void {
  server.setLaunchAuthorityVerifier(
    (candidate, handle) => runtime.verifyAgentHookLaunchAuthority(candidate, handle),
    (listener) => runtime.subscribeAgentLaunchAuthority(listener)
  )
}

type OrcaRuntimeServiceDeps = NonNullable<ConstructorParameters<typeof OrcaRuntimeService>[2]>

/** Drain the microtask + timer queues the deferred foreground read chains through. */
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
    const server = new AgentHookServer()
    servers.push(server)
    await server.start({ env: 'production' })
    const pane = await launchOpenCodePane({
      ptyId: 'pty-opencode-reuse',
      // OpenCode is a TUI: it is still the foreground process when its command completes.
      getForegroundProcess: async () => 'opencode',
      retireAgentHookCompatibilityAuthority: (paneKey) => server.retirePaneAuthority(paneKey),
      attestAgentHookCompatibilityAuthority: (candidate) =>
        server.attestCompatibilityAuthority(candidate)
    })
    connectAuthority(server, pane.runtime)
    const hookEnv = server.buildPtyEnv()
    const post = (payload: Record<string, unknown>): Promise<Response> =>
      fetch(`http://127.0.0.1:${hookEnv.ORCA_AGENT_HOOK_PORT}/hook/opencode`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Orca-Agent-Hook-Token': hookEnv.ORCA_AGENT_HOOK_TOKEN
        },
        body: JSON.stringify({
          paneKey: pane.paneKey,
          launchToken: pane.launchToken,
          tabId: pane.tabId,
          worktreeId: pane.runtime.getOrchestrationDispatchAuthority(pane.evidence.terminalHandle)
            ?.worktreeId,
          env: 'production',
          payload
        })
      })

    await post({ hook_event_name: 'SessionStart', sessionID: 'session-1' })
    await post({ hook_event_name: 'SessionBusy', sessionID: 'session-1' })
    expect(
      server.attestCompatibilityAuthority({
        paneKey: pane.paneKey,
        launchTokenHash: createHash('sha256').update(pane.launchToken).digest('hex'),
        connectionId: null,
        terminalProvenance: 'current_runtime'
      })
    ).not.toBeNull()

    pane.runtime.onPtyData(pane.ptyId, '\x1b]133;D;0\x07\x1b]133;A\x07', 100)
    await settle()

    // Every later process in this shell inherits ORCA_AGENT_LAUNCH_TOKEN from the PTY env,
    // so the finished session's token must stop attesting once its command completed.
    expect(
      server.attestCompatibilityAuthority({
        paneKey: pane.paneKey,
        launchTokenHash: createHash('sha256').update(pane.launchToken).digest('hex'),
        connectionId: null,
        terminalProvenance: 'current_runtime'
      })
    ).toBeNull()
  })

  it('does not let a later OpenCode session satisfy the previous pending retirement', async () => {
    const userDataPath = mkdtempSync(join(tmpdir(), 'orca-sta4557-successor-'))
    tempDirs.push(userDataPath)
    let server = new AgentHookServer()
    servers.push(server)
    await server.start({ env: 'production', userDataPath })
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
      captureAgentHookCompatibilityRetirement: (paneKey) =>
        server.capturePaneAuthorityRetirement(paneKey),
      retireAgentHookCompatibilityAuthority: (paneKey) => server.retirePaneAuthority(paneKey),
      attestAgentHookCompatibilityAuthority: (candidate) =>
        server.attestCompatibilityAuthority(candidate)
    })
    let hookEnv = server.buildPtyEnv()
    // Both sessions post the same launchToken: it lives in the PTY env, so every
    // process started in this shell inherits it. Only sessionID separates them.
    const post = (
      sessionId: string,
      hookEvent = 'SessionBusy',
      token = pane.launchToken
    ): Promise<Response> =>
      fetch(`http://127.0.0.1:${hookEnv.ORCA_AGENT_HOOK_PORT}/hook/opencode`, {
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
          payload: { hook_event_name: hookEvent, sessionID: sessionId }
        })
      })
    const attestCurrent = (): unknown =>
      server.attestCompatibilityAuthority({
        paneKey: pane.paneKey,
        launchTokenHash: createHash('sha256').update(pane.launchToken).digest('hex'),
        connectionId: null,
        terminalProvenance: 'current_runtime'
      })

    await post('session-1')
    expect(attestCurrent()).toBeNull()
    // The one-shot hook precedes verifier installation, then qualifies against the real launch.
    connectAuthority(server, pane.runtime)
    expect(attestCurrent()).not.toBeNull()

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
    server = new AgentHookServer()
    servers.push(server)
    await server.start({ env: 'production', userDataPath })
    hookEnv = server.buildPtyEnv()
    connectAuthority(server, pane.runtime)
    expect(successor()?.providerSession?.id).toBe('session-2')
    await post('session-2')
    expect(successor()?.state).toBe('working')
    expect(attestCurrent()).toBeNull()
    expect(
      server.attestCompatibilityAuthority({
        paneKey: pane.paneKey,
        launchTokenHash: createHash('sha256').update(pane.launchToken).digest('hex'),
        connectionId: null,
        terminalProvenance: 'restored'
      })
    ).toBeNull()
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
    expect(
      server.attestCompatibilityAuthority({
        paneKey: pane.paneKey,
        launchTokenHash: createHash('sha256').update(freshToken).digest('hex'),
        connectionId: null,
        terminalProvenance: 'current_runtime'
      })
    ).not.toBeNull()
    expect(attestCurrent()).toBeNull()
  })
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
    const hookEnv = first.buildPtyEnv()
    await fetch(`http://127.0.0.1:${hookEnv.ORCA_AGENT_HOOK_PORT}/hook/opencode`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Orca-Agent-Hook-Token': hookEnv.ORCA_AGENT_HOOK_TOKEN
      },
      body: JSON.stringify({
        paneKey: pane.paneKey,
        launchToken: pane.launchToken,
        tabId: pane.tabId,
        worktreeId: pane.runtime.getOrchestrationDispatchAuthority(pane.evidence.terminalHandle)
          ?.worktreeId,
        env: 'production',
        payload: { hook_event_name: 'SessionStart', sessionID: 'session-1' }
      })
    })

    pane.runtime.onPtyData(pane.ptyId, '\x1b]133;D;0\x07\x1b]133;A\x07', 100)
    await settle()
    first.flushStatusPersistSync()
    first.stop()

    const restarted = new AgentHookServer()
    servers.push(restarted)
    await restarted.start({ env: 'production', userDataPath })

    // After a restart the PTY survives with ORCA_AGENT_LAUNCH_TOKEN still in its env and
    // pty.launchToken gone, so a persisted commitment is the whole proof of authority.
    expect(
      restarted.attestCompatibilityAuthority({
        paneKey: pane.paneKey,
        launchTokenHash: createHash('sha256').update(pane.launchToken).digest('hex'),
        connectionId: null,
        terminalProvenance: 'restored'
      })
    ).toBeNull()
  })
})
