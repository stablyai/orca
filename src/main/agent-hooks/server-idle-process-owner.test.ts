import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AgentHookServer } from './server'
import { buildBody, PANE, postHookEvent } from './server.test-fixtures'
import { buildRuntimeMobileAgentStatus } from '../runtime/runtime-mobile-agent-status-builder'
import { getAgentResumeArgv } from '../../shared/agent-session-resume'
import type { probeAgentProcessPresence } from '../../shared/agent-process-presence-probe'

vi.mock('../telemetry/client', () => ({ track: vi.fn() }))
vi.mock('../telemetry/cohort-classifier', () => ({ getCohortAtEmit: () => ({}) }))
const probe = vi.hoisted(() => vi.fn<typeof probeAgentProcessPresence>(async () => 'live'))
vi.mock('../../shared/agent-process-presence-probe', () => ({ probeAgentProcessPresence: probe }))
const servers: AgentHookServer[] = []
const owner = {
  agent: 'claude',
  sessionOwner: true as const,
  process: { pid: 4001, platform: 'linux', startTime: 'birth-4001' }
}

afterEach(() => {
  for (const server of servers.splice(0)) {
    server.stop()
  }
  probe.mockReset().mockResolvedValue('live')
  vi.restoreAllMocks()
})

async function start(userDataPath?: string): Promise<AgentHookServer> {
  const server = new AgentHookServer()
  servers.push(server)
  await server.start({ env: 'production', userDataPath })
  return server
}

async function idleClaude(server: AgentHookServer): Promise<void> {
  for (const hook_event_name of ['UserPromptSubmit', 'Stop']) {
    await postHookEvent(
      server,
      buildBody(
        {
          hook_event_name,
          session_id: 'claude-parent',
          prompt: 'Foreground task'
        },
        { agentProcess: JSON.stringify(owner.process) }
      )
    )
  }
}

function mobile(server: AgentHookServer) {
  return buildRuntimeMobileAgentStatus(
    null,
    {
      type: 'terminal',
      id: 'tab-1::leaf',
      parentTabId: 'tab-1',
      leafId: 'leaf',
      title: 'Claude',
      launchAgent: 'claude',
      isActive: true
    },
    null,
    null,
    () => server.getStatusSnapshot(),
    {
      getPaneKey: () => PANE,
      getLeaf: () => null,
      getTrackedTitle: () => null
    }
  )
}

function assertClaudeSession(server: AgentHookServer): void {
  expect(mobile(server)).toMatchObject({
    agentStatus: {
      agentType: 'claude',
      providerSession: { id: 'claude-parent' }
    }
  })
  const row = server.getStatusSnapshot().find((row) => row.paneKey === PANE)
  expect(row?.agentType).toBe('claude')
  if (!row?.providerSession) {
    throw new Error('Missing foreground session')
  }
  expect(getAgentResumeArgv('claude', row.providerSession)).toEqual([
    'claude',
    '--resume',
    'claude-parent'
  ])
}

describe('idle foreground process owns its provider session', () => {
  it.each(['live', 'unverifiable'] as const)(
    'rechecks prior suspension before a nested provider when the owner is now %s',
    async (verdict) => {
      const server = await start()
      await idleClaude(server)
      const emitted = vi.fn()
      server.setListener(emitted)
      emitted.mockClear()
      probe.mockImplementation(async (_identity, _read, _platform, observe) => {
        observe?.(true)
        return 'unverifiable'
      })
      await server.checkAgentPresence(PANE)
      expect(emitted.mock.lastCall?.[0].agentPresence?.suspended).toBe(true)
      probe.mockImplementation(async (_identity, _read, _platform, observe) => {
        if (verdict === 'live') {
          observe?.(false)
        }
        return verdict
      })
      await postHookEvent(
        server,
        buildBody({
          hook_event_name: 'UserPromptSubmit',
          session_id: 'nested-codex',
          prompt: 'Background review'
        }),
        '/hook/codex'
      )
      expect(probe).toHaveBeenCalledTimes(2)
      assertClaudeSession(server)
      expect(emitted.mock.lastCall?.[0].agentPresence?.suspended).toBeUndefined()
    }
  )

  it.each([false, true])(
    'keeps interrupted spool replay durable (re-enable: %s)',
    async (reEnable) => {
      const directory = mkdtempSync(join(tmpdir(), 'idle-owner-disabled-spool-'))
      let server: AgentHookServer | undefined
      try {
        const first = await start(directory)
        await idleClaude(first)
        first.flushStatusPersistSync()
        first.stop()
        const spool = join(directory, 'agent-hooks', 'spool')
        mkdirSync(spool, { recursive: true })
        const path = join(spool, 'replacement.jsonl')
        const contents = `${JSON.stringify({
          paneKey: PANE,
          tabId: 'tab-1',
          worktreeId: 'wt-1',
          source: 'codex',
          receivedAt: Date.now(),
          payload: { hook_event_name: 'UserPromptSubmit', session_id: 'replacement' }
        })}\n`
        writeFileSync(path, contents)
        server = new AgentHookServer()
        servers.push(server)
        await server.start({
          env: 'production',
          userDataPath: directory,
          statusHooksEnabled: false
        })
        let release: (() => void) | undefined
        probe.mockImplementationOnce(
          () =>
            new Promise((resolve) => {
              release = () => resolve('live')
            })
        )
        const log = vi.spyOn(console, 'error').mockImplementation(() => {})
        server.setStatusHooksEnabled(true)
        expect(probe).toHaveBeenCalledTimes(1)
        server.setStatusHooksEnabled(false)
        if (reEnable) {
          server.setStatusHooksEnabled(true)
        }
        release?.()
        await vi.waitFor(() => expect(log).toHaveBeenCalled())
        expect(readFileSync(path, 'utf8')).toBe(contents)
        expect(server.getStatusSnapshot()[0].agentType).toBe('claude')
      } finally {
        server?.stop()
        rmSync(directory, { recursive: true, force: true })
      }
    }
  )

  it.each(['live', 'exited'] as const)(
    'orders spooled replacements after checking a hydrated %s process owner',
    async (verdict) => {
      const directory = mkdtempSync(join(tmpdir(), 'idle-owner-spool-'))
      let restarted: AgentHookServer | undefined
      try {
        const first = await start(directory)
        await idleClaude(first)
        first.flushStatusPersistSync()
        first.stop()
        probe.mockResolvedValue(verdict)
        const spool = join(directory, 'agent-hooks', 'spool')
        mkdirSync(spool, { recursive: true })
        writeFileSync(
          join(spool, 'replacement.jsonl'),
          ['UserPromptSubmit', 'PreToolUse']
            .map(
              (hookEventName) =>
                `${JSON.stringify({
                  paneKey: PANE,
                  tabId: 'tab-1',
                  worktreeId: 'wt-1',
                  source: 'codex',
                  receivedAt: Date.now(),
                  hookEventName,
                  payload: {
                    hook_event_name: hookEventName,
                    session_id: 'spooled-codex',
                    prompt: 'Replacement task',
                    tool_name: 'shell'
                  }
                })}\n`
            )
            .join('')
        )
        restarted = await start(directory)
        expect(restarted.getStatusSnapshot()[0]).toMatchObject({
          agentType: verdict === 'live' ? 'claude' : 'codex',
          providerSession: { id: verdict === 'live' ? 'claude-parent' : 'spooled-codex' }
        })
        expect(restarted.getStatusSnapshot()[0].prompt).toBe(
          verdict === 'live' ? 'Foreground task' : 'Replacement task'
        )
      } finally {
        restarted?.stop()
        rmSync(directory, { recursive: true, force: true })
      }
    }
  )

  it('accepts the first foreground replacement after positive suspension without claiming exit', async () => {
    const server = await start()
    await idleClaude(server)
    probe.mockImplementation(async (_identity, _read, _platform, observe) => {
      observe?.(true)
      return 'unverifiable'
    })
    const emitted = vi.fn()
    server.setListener(emitted)
    emitted.mockClear()
    await postHookEvent(
      server,
      buildBody({
        hook_event_name: 'UserPromptSubmit',
        session_id: 'foreground-codex',
        prompt: 'New foreground task'
      }),
      '/hook/codex'
    )
    expect(emitted.mock.calls[0]?.[0].agentPresence).toMatchObject({
      agent: 'claude',
      suspended: true
    })
    expect(emitted.mock.calls[0]?.[0].agentPresence.ended).toBeUndefined()
    expect(server.getStatusSnapshot()[0]).toMatchObject({
      agentType: 'codex',
      providerSession: { id: 'foreground-codex' }
    })
  })

  it.each(['done', 'working'] as const)(
    'preserves the legacy remote %s replacement policy without host support',
    async (state) => {
      const server = await start()
      const { sessionOwner: _sessionOwner, ...legacyOwner } = owner
      server.ingestRemote(
        {
          paneKey: PANE,
          agentPresence: legacyOwner,
          payload: { agentType: 'claude', state, prompt: 'Legacy owner' }
        },
        'ssh-old'
      )
      server.ingestRemote(
        {
          paneKey: PANE,
          payload: { agentType: 'codex', state: 'working', prompt: 'Replacement' }
        },
        'ssh-old'
      )
      expect(server.getStatusSnapshot()[0].agentType).toBe(state === 'done' ? 'codex' : 'claude')
      expect(probe).not.toHaveBeenCalled()
    }
  )

  it.each(['live', 'unverifiable'] as const)(
    'retains mobile and resume selection after turn completion when owner is %s',
    async (verdict) => {
      const server = await start()
      probe.mockResolvedValue(verdict)
      await idleClaude(server)
      const before = server.getStatusSnapshot()
      const emit = vi.fn()
      server.setListener(emit)
      emit.mockClear()
      for (const hook_event_name of [
        'SessionStart',
        'UserPromptSubmit',
        'PreToolUse',
        'PermissionRequest',
        'Stop'
      ]) {
        await postHookEvent(
          server,
          buildBody({
            hook_event_name,
            session_id: 'nested-codex',
            prompt: 'Background review',
            tool_name: 'shell'
          }),
          '/hook/codex'
        )
        assertClaudeSession(server)
        expect(server.getStatusSnapshot()).toEqual(before)
      }
      expect(probe).toHaveBeenCalledTimes(5)
      expect(emit).not.toHaveBeenCalled()
      await postHookEvent(
        server,
        buildBody(
          { hook_event_name: 'PreToolUse', session_id: 'claude-parent', tool_name: 'Read' },
          { agentProcess: JSON.stringify(owner.process) }
        )
      )
      expect(server.getStatusSnapshot()[0].prompt).toBe('Foreground task')
    }
  )

  it('accepts the first replacement hook after a positive process exit', async () => {
    const server = await start()
    await idleClaude(server)
    probe.mockResolvedValue('exited')
    await postHookEvent(
      server,
      buildBody({
        hook_event_name: 'UserPromptSubmit',
        session_id: 'replacement-codex',
        prompt: 'New foreground task'
      }),
      '/hook/codex'
    )
    expect(server.getStatusSnapshot()[0]).toMatchObject({
      agentType: 'codex',
      providerSession: { id: 'replacement-codex' },
      prompt: 'New foreground task'
    })
  })

  it('protects an old idle owner without treating elapsed time as process exit', async () => {
    const server = await start()
    await idleClaude(server)
    const now = Date.now()
    vi.spyOn(Date, 'now').mockReturnValue(now + 24 * 60 * 60 * 1000)
    await postHookEvent(
      server,
      buildBody({ hook_event_name: 'UserPromptSubmit', session_id: 'nested-codex' }),
      '/hook/codex'
    )
    assertClaudeSession(server)
  })

  it('keeps remote ownership until its execution host reports exit, without probing locally', async () => {
    const server = await start()
    const parent = {
      paneKey: PANE,
      tabId: 'tab-1',
      worktreeId: 'wt-1',
      source: 'claude',
      hookEventName: 'Stop',
      agentPresence: owner,
      providerSession: { key: 'session_id', id: 'claude-parent' },
      payload: { agentType: 'claude', state: 'done', prompt: 'Foreground task' }
    }
    server.ingestRemote(parent, 'ssh-a')
    const nested = {
      ...parent,
      source: 'codex',
      hookEventName: 'UserPromptSubmit',
      providerSession: { key: 'session_id', id: 'nested-codex' },
      payload: { agentType: 'codex', state: 'working', prompt: 'Background review' }
    }
    server.ingestRemote(nested, 'ssh-a')
    assertClaudeSession(server)
    expect(probe).not.toHaveBeenCalled()
    server.ingestRemote(
      {
        ...parent,
        hookEventName: 'AgentProcessExit',
        providerSessionOnly: true,
        agentPresence: { ...owner, ended: true }
      },
      'ssh-a'
    )
    server.ingestRemote({ ...nested, agentPresence: undefined }, 'ssh-a')
    expect(server.getStatusSnapshot()[0]).toMatchObject({
      agentType: 'codex',
      providerSession: { id: 'nested-codex' }
    })
  })

  it('does not carry a process owner into a different execution host', async () => {
    const server = await start()
    await idleClaude(server)
    server.ingestRemote(
      {
        paneKey: PANE,
        tabId: 'tab-1',
        worktreeId: 'wt-1',
        source: 'codex',
        providerSession: { key: 'session_id', id: 'remote-codex' },
        payload: { agentType: 'codex', state: 'working', prompt: 'Remote task' }
      },
      'ssh-other'
    )
    expect(server.getStatusSnapshot()[0]).toMatchObject({
      agentType: 'codex',
      providerSession: { id: 'remote-codex' }
    })
    expect(await server.checkAgentPresence(PANE)).toBeNull()
    expect(probe).not.toHaveBeenCalled()
  })
})
