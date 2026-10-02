import { createHash } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AgentHookServer } from '../agent-hooks/server'
import { OrcaRuntimeService } from './orca-runtime'
import { makeStore } from './runtime-rpc-worktree-store-fixtures'

const WORKTREE_PATH = '/tmp/worktree-a'
const WORKTREE = {
  path: WORKTREE_PATH,
  head: 'abc',
  branch: 'feature/opencode-authority',
  isBare: false,
  isMainWorktree: false
}

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
  retireAgentHookCompatibilityAuthority?: (paneKey: string) => void
  attestAgentHookCompatibilityAuthority?: OrcaRuntimeServiceDeps['attestAgentHookCompatibilityAuthority']
}): Promise<LaunchedOpenCodePane> {
  const spawn = vi.fn().mockResolvedValue({ id: options.ptyId, incarnationId: 'incarnation-1' })
  const runtime = new OrcaRuntimeService(makeStore() as never, undefined, {
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
    getForegroundProcess: options.getForegroundProcess
  })
  const terminal = await runtime.createTerminal(`path:${WORKTREE.path}`, {
    command: 'opencode',
    launchConfig: { agentCommand: 'opencode', agentArgs: '', agentEnv: {} },
    launchAgent: 'opencode'
  })
  const env = (spawn.mock.calls[0]?.[0] as { env?: Record<string, string> } | undefined)?.env ?? {}
  const paneKey = env.ORCA_PANE_KEY as string
  const launchToken = env.ORCA_AGENT_LAUNCH_TOKEN as string
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

type OrcaRuntimeServiceDeps = NonNullable<ConstructorParameters<typeof OrcaRuntimeService>[2]>

// Drain deferred foreground reads before asserting retirement.
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

    // A title repaint does not invalidate the execution host's shell observation.
    pane.runtime.onPtyData(pane.ptyId, '\x1b]133;D;0\x07', 100)
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

    pane.runtime.onPtyData(pane.ptyId, '\x1b]133;D;0\x07', 100)
    await settle()

    expect(pane.runtime.verifyOrchestrationCompatibilityCaller(pane.evidence)).toBeNull()
  })

  it('stops attesting the finished session token for the reused pane', async () => {
    const server = new AgentHookServer()
    servers.push(server)
    await server.start({ env: 'production' })
    const pane = await launchOpenCodePane({
      ptyId: 'pty-opencode-reuse',
      getForegroundProcess: async () => 'zsh',
      retireAgentHookCompatibilityAuthority: (paneKey) => server.retirePaneAuthority(paneKey),
      attestAgentHookCompatibilityAuthority: (candidate) =>
        server.attestCompatibilityAuthority(candidate)
    })
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
          worktreeId: 'wt-opencode',
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

    pane.runtime.onPtyData(pane.ptyId, '\x1b]133;D;0\x07', 100)
    await settle()

    // A confirmed shell cannot use its previous agent's inherited launch token.
    expect(
      server.attestCompatibilityAuthority({
        paneKey: pane.paneKey,
        launchTokenHash: createHash('sha256').update(pane.launchToken).digest('hex'),
        connectionId: null,
        terminalProvenance: 'current_runtime'
      })
    ).toBeNull()
  })

  it('does not rehydrate a finished session token as restored authority after a restart', async () => {
    const userDataPath = mkdtempSync(join(tmpdir(), 'orca-sta4557-'))
    tempDirs.push(userDataPath)
    const first = new AgentHookServer()
    servers.push(first)
    await first.start({ env: 'production', userDataPath })
    const pane = await launchOpenCodePane({
      ptyId: 'pty-opencode-restart',
      getForegroundProcess: async () => 'zsh',
      retireAgentHookCompatibilityAuthority: (paneKey) => first.retirePaneAuthority(paneKey)
    })
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
        worktreeId: 'wt-opencode',
        env: 'production',
        payload: { hook_event_name: 'SessionStart', sessionID: 'session-1' }
      })
    })

    pane.runtime.onPtyData(pane.ptyId, '\x1b]133;D;0\x07', 100)
    await settle()
    first.flushStatusPersistSync()
    first.stop()

    const restarted = new AgentHookServer()
    servers.push(restarted)
    await restarted.start({ env: 'production', userDataPath })

    // Retired launch commitments must not become authority after a hook-server restart.
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
