import { describe, expect, vi } from 'vitest'
import { forgetRefusedPaneResumeMock, spawnMock } from './pty-ipc-mock-registry'
import { posixOnlyIt } from './pty-ipc-test-constants'
import { setupPtyIpcSuite } from './pty-ipc-test-harness'
import { POSIX_SHELL_STARTUP_COMMAND_ENV } from '../pty/posix-shell-startup-command'
import { registerPtyHandlers } from './pty/register-handlers'
import { OrcaRuntimeService } from '../runtime/orca-runtime'
import { AgentSessionRecordStore } from '../runtime/agent-session-record-store'
import { partialRuntimeStore } from '../runtime/runtime-store-partial-fixture'
import type { TuiAgent } from '../../shared/tui-agent'
import {
  agentSessionLeaseFixture,
  agentSessionRecordFixture
} from '../../shared/agent-session-record.test-fixture'

vi.mock('electron', () => import('./pty-ipc-mock-registry').then((m) => m.electronModuleMock()))
vi.mock('fs', () => import('./pty-ipc-mock-registry').then((m) => m.fsModuleMock()))
vi.mock('node-pty', () => import('./pty-ipc-mock-registry').then((m) => m.nodePtyModuleMock()))
vi.mock('node:child_process', async (importOriginal) =>
  (await import('./pty-ipc-mock-registry')).childProcessModuleMock(await importOriginal())
)
vi.mock('../opencode/hook-service', () =>
  import('./pty-ipc-mock-registry').then((m) => m.openCodeHookServiceModuleMock())
)
vi.mock('../mimo/hook-service', () =>
  import('./pty-ipc-mock-registry').then((m) => m.mimoHookServiceModuleMock())
)
vi.mock('../agent-hooks/server', () =>
  import('./pty-ipc-mock-registry').then((m) => m.agentHookServerModuleMock())
)
vi.mock('../pi/titlebar-extension-service', () =>
  import('./pty-ipc-mock-registry').then((m) => m.piTitlebarExtensionModuleMock())
)
vi.mock('../pwsh', () => import('./pty-ipc-mock-registry').then((m) => m.pwshModuleMock()))
vi.mock('../wsl', async (importOriginal) =>
  (await import('./pty-ipc-mock-registry')).wslModuleMock(await importOriginal())
)
vi.mock('../telemetry/client', () =>
  import('./pty-ipc-mock-registry').then((m) => m.telemetryClientModuleMock())
)
vi.mock('../telemetry/classify-error', () =>
  import('./pty-ipc-mock-registry').then((m) => m.classifyErrorModuleMock())
)
vi.mock('../cli/linux-terminal-orca-cli-shim', () =>
  import('./pty-ipc-mock-registry').then((m) => m.linuxCliShimModuleMock())
)
vi.mock('../memory/pty-registry', () =>
  import('./pty-ipc-mock-registry').then((m) => m.ptyRegistryModuleMock())
)
vi.mock('../agent-hooks/migration-unsupported-pty-state', () =>
  import('./pty-ipc-mock-registry').then((m) => m.migrationUnsupportedPtyModuleMock())
)
vi.mock('../codex/codex-pane-account-registry', () =>
  import('./pty-ipc-mock-registry').then((m) => m.codexPaneAccountRegistryModuleMock())
)
vi.mock('../codex/codex-state-db-backfill-recovery', () =>
  import('./pty-ipc-mock-registry').then((m) => m.codexBackfillRecoveryModuleMock())
)

// #26417: a pane that saved a chat's conversation must not resume it while the chat is its home.
describe('a pane restore of a conversation a native chat continues', () => {
  const { handlers, mainWindow, createMockProc } = setupPtyIpcSuite()
  const chat = agentSessionRecordFixture(
    agentSessionLeaseFixture({
      claimStatus: 'released',
      ownerProcess: null,
      reservedSpawnToken: null,
      deathEvidence: { kind: 'exit-observed', detail: 'closed', observedAt: 1 }
    })
  )
  const C = 'provider-session-alpha-1'
  const LEAF_ID = '11111111-1111-4111-8111-111111111111'

  function register(openTabs: string[] | 'unreadable', disabledTuiAgents: TuiAgent[] = []) {
    const runtime = new OrcaRuntimeService(
      partialRuntimeStore({ getSettings: () => ({ disabledTuiAgents }) })
    )
    vi.spyOn(runtime, 'resolveTerminalWorkspaceLaunchScope').mockResolvedValue({
      id: 'wt-1',
      path: '/tmp',
      connectionId: null,
      repo: null,
      folderWorkspace: null
    })
    vi.spyOn(runtime, 'planAgentPaneLaunch')
    vi.spyOn(runtime, 'openAgentSessionRecordStore').mockImplementation(async () => {
      if (openTabs === 'unreadable') {
        throw new Error('records unavailable')
      }
      const store: AgentSessionRecordStore = Object.create(AgentSessionRecordStore.prototype)
      store.listRecords = () => [chat]
      store.getVisibleSessionTabIndex = () => ({ present: true, sessionIds: openTabs })
      return store
    })
    registerPtyHandlers(mainWindow, runtime)
    return runtime
  }

  async function spawnResume(resumeOrigin?: 'saved', leafId = LEAF_ID, typed = false) {
    const mockProc = createMockProc()
    spawnMock.mockReturnValue(mockProc.proc)
    vi.useFakeTimers()
    try {
      const result = await handlers.get('pty:spawn')!(null, {
        cols: 80,
        rows: 24,
        cwd: '/tmp',
        worktreeId: 'wt-1',
        tabId: 'tab-floating',
        leafId,
        ...(typed
          ? { resume: { recipe: { source: 'saved' } } }
          : { command: `claude --resume '${C}'` }),
        launchAgent: 'claude',
        resumeProviderSession: { key: 'session_id', id: C },
        ...(resumeOrigin ? { resumeOrigin } : {})
      })
      for (let flush = 0; flush < 3; flush += 1) {
        await Promise.resolve()
        vi.runAllTimers()
      }
      const env: Record<string, string> = spawnMock.mock.calls.at(-1)![2].env
      const inputWrites = mockProc.proc.write.mock.calls.map((call) => String(call[0]))
      const reported = typeof result === 'object' && result !== null ? result : {}
      return {
        refused: 'agentResumeRefused' in reported ? reported.agentResumeRefused : undefined,
        notice: 'agentResumeUnavailable' in reported,
        input: [env[POSIX_SHELL_STARTUP_COMMAND_ENV] ?? '', ...inputWrites].join('\n')
      }
    } finally {
      vi.useRealTimers()
    }
  }

  posixOnlyIt(
    'starts the plain shell with the notice and forgets the pane claim while the chat tab is open',
    async () => {
      register([chat.sessionId])
      const restored = await spawnResume('saved')
      expect(restored).toMatchObject({ refused: 'chat-home', notice: true })
      expect(restored.input).not.toContain(C)
      expect(forgetRefusedPaneResumeMock).toHaveBeenCalledWith(`tab-floating:${LEAF_ID}`, {
        agent: 'claude',
        providerSession: { key: 'session_id', id: C }
      })
    }
  )

  posixOnlyIt('runs real typed planning then strips the resume at saved admission', async () => {
    const runtime = register([chat.sessionId])
    const restored = await spawnResume('saved', LEAF_ID, true)
    const planned = await vi.mocked(runtime.planAgentPaneLaunch).mock.results[0]!.value
    expect(planned.command).toContain(C)
    expect(restored).toMatchObject({ refused: 'chat-home', notice: true })
    expect(restored.input).not.toContain(C)
    expect(restored.input).not.toContain('--resume')
    expect(spawnMock).toHaveBeenCalledOnce()
    expect(forgetRefusedPaneResumeMock).toHaveBeenCalledWith(`tab-floating:${LEAF_ID}`, {
      agent: 'claude',
      providerSession: { key: 'session_id', id: C }
    })
  })

  posixOnlyIt(
    'recovers a disabled saved desktop agent while ensure and saved mobile still refuse',
    async () => {
      const runtime = register([], ['claude'])
      const restored = await spawnResume('saved', LEAF_ID, true)
      expect(restored.refused).toBeUndefined()
      expect(restored.input.split(C)).toHaveLength(2)
      await expect(runtime.planAgentPaneLaunch('wt-1', { startupAgent: 'claude' })).rejects.toThrow(
        'Agent claude is disabled'
      )
      Object.assign(runtime, { executionOwnerSupportsAgentSessionOperation: async () => true })
      await expect(
        runtime.ensureAgentSession({
          kind: 'explicit',
          worktree: 'id:wt-1',
          agent: 'claude',
          providerSession: { key: 'session_id', id: C },
          resume: { recipe: { source: 'saved' } }
        })
      ).rejects.toThrow('Selected agent is disabled')
      expect(
        runtime['resolveMobileSessionResumeCommand'](
          { id: 'wt-1', path: '/tmp', connectionId: null, repo: null, folderWorkspace: null },
          { agent: 'claude', providerSession: { key: 'session_id', id: C } }
        )
      ).toBeNull()
    }
  )

  posixOnlyIt('keeps a committed refused shell usable when status cleanup fails', async () => {
    register([chat.sessionId])
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {})
    forgetRefusedPaneResumeMock.mockImplementationOnce(() => {
      throw new Error('cleanup failed')
    })
    try {
      const restored = await spawnResume('saved')
      expect(restored).toMatchObject({ refused: 'chat-home', notice: true })
      expect(restored.input).not.toContain(C)
      expect(warning).toHaveBeenCalled()
    } finally {
      warning.mockRestore()
    }
  })

  posixOnlyIt(
    'resumes once the chat tab is closed, with the accepted pre-report interval',
    async () => {
      const runtime = register([])
      const restored = await spawnResume('saved')
      expect(restored.refused).toBeUndefined()
      expect(restored.input).toContain(`--resume '${C}'`)
      await expect(runtime['assertStructuredChatAcquireAdmissible'](chat)).resolves.toBeUndefined()
    }
  )

  posixOnlyIt(
    'with unreadable records refuses only a saved restore, and keeps its record',
    async () => {
      vi.spyOn(console, 'warn').mockImplementation(() => {})
      register('unreadable')
      const restored = await spawnResume('saved')
      const asked = await spawnResume(undefined, '22222222-2222-4222-8222-222222222222')
      expect(restored.refused).toBe('unverifiable')
      expect(restored.input).not.toContain(C)
      expect(asked.refused).toBeUndefined()
      expect(asked.input).toContain(`--resume '${C}'`)
      expect(forgetRefusedPaneResumeMock).not.toHaveBeenCalled()
    }
  )

  posixOnlyIt('leaves an explicit resume of a chat at rest alone', async () => {
    register([chat.sessionId])
    const asked = await spawnResume()
    expect(asked.refused).toBeUndefined()
    expect(asked.input).toContain(`--resume '${C}'`)
  })
})
