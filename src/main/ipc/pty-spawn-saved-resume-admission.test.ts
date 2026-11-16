import { describe, expect, vi } from 'vitest'
import { forgetRefusedPaneResumeMock, spawnMock } from './pty/pty-ipc-mock-registry'
import { posixOnlyIt } from './pty/pty-ipc-test-constants'
import { setupPtyIpcSuite } from './pty/pty-ipc-test-harness'
import { POSIX_SHELL_STARTUP_COMMAND_ENV } from '../pty/shell-startup/posix-shell-startup-command'
import { registerPtyHandlers } from './pty/register-handlers'
import { OrcaRuntimeService } from '../runtime/orca-runtime'
import { agentSessionConversationView } from '../../shared/agent-session/lifecycle/leases/agent-session-conversation-view'
import { AgentSessionRecordStore } from '../runtime/agent-session/records/agent-session-record-store'
import {
  agentSessionLeaseFixture,
  agentSessionRecordFixture
} from '../../shared/agent-session/lifecycle/records/agent-session-record.test-fixture'

vi.mock('electron', () => import('./pty/pty-ipc-mock-registry').then((m) => m.electronModuleMock()))
vi.mock('fs', () => import('./pty/pty-ipc-mock-registry').then((m) => m.fsModuleMock()))
vi.mock('node-pty', () => import('./pty/pty-ipc-mock-registry').then((m) => m.nodePtyModuleMock()))
vi.mock('node:child_process', async (importOriginal) =>
  (await import('./pty/pty-ipc-mock-registry')).childProcessModuleMock(await importOriginal())
)
vi.mock('../opencode/status-hooks/hook-service', () =>
  import('./pty/pty-ipc-mock-registry').then((m) => m.openCodeHookServiceModuleMock())
)
vi.mock('../mimo/hook-service', () =>
  import('./pty/pty-ipc-mock-registry').then((m) => m.mimoHookServiceModuleMock())
)
vi.mock('../agent-hooks/server/agent-hook-server', () =>
  import('./pty/pty-ipc-mock-registry').then((m) => m.agentHookServerModuleMock())
)
vi.mock('../pi/managed-extensions/titlebar-extension-service', () =>
  import('./pty/pty-ipc-mock-registry').then((m) => m.piTitlebarExtensionModuleMock())
)
vi.mock('../pty/shell-startup/pwsh', () =>
  import('./pty/pty-ipc-mock-registry').then((m) => m.pwshModuleMock())
)
vi.mock('../wsl/filesystem/unc-path-access', async (importOriginal) =>
  (await import('./pty/pty-ipc-mock-registry')).wslModuleMock(await importOriginal())
)
vi.mock('../telemetry/client', () =>
  import('./pty/pty-ipc-mock-registry').then((m) => m.telemetryClientModuleMock())
)
vi.mock('../telemetry/classify-error', () =>
  import('./pty/pty-ipc-mock-registry').then((m) => m.classifyErrorModuleMock())
)
vi.mock('../cli/launchers/linux-terminal-orca-cli-shim', () =>
  import('./pty/pty-ipc-mock-registry').then((m) => m.linuxCliShimModuleMock())
)
vi.mock('../memory/pty-registry', () =>
  import('./pty/pty-ipc-mock-registry').then((m) => m.ptyRegistryModuleMock())
)
vi.mock('../agent-hooks/observations/migration-unsupported-pty-state', () =>
  import('./pty/pty-ipc-mock-registry').then((m) => m.migrationUnsupportedPtyModuleMock())
)
vi.mock('../codex/configuration/homes/codex-pane-account-registry', () =>
  import('./pty/pty-ipc-mock-registry').then((m) => m.codexPaneAccountRegistryModuleMock())
)
vi.mock('../codex/history/index/codex-state-db-backfill-recovery', () =>
  import('./pty/pty-ipc-mock-registry').then((m) => m.codexBackfillRecoveryModuleMock())
)

// #26417: a pane that saved a chat's conversation must not resume it while the chat is its home.
describe('a pane restore of a conversation a native chat continues', () => {
  const { handlers, mainWindow, createMockProc } = setupPtyIpcSuite()
  const chat = agentSessionRecordFixture(
    agentSessionLeaseFixture({
      claimStatus: 'released',
      ownerProcess: null,
      reservedSpawnToken: null,
      deathEvidence: { kind: 'kill-delivered', detail: 'writer terminated', observedAt: 1 }
    })
  )
  const C = 'provider-session-alpha-1'
  const LEAF_ID = '11111111-1111-4111-8111-111111111111'

  function register(openTabs: string[] | 'unreadable') {
    const runtime = new OrcaRuntimeService()
    vi.spyOn(runtime, 'openAgentSessionRecordStore').mockImplementation(async () => {
      if (openTabs === 'unreadable') {
        throw new Error('records unavailable')
      }
      const store: AgentSessionRecordStore = Object.create(AgentSessionRecordStore.prototype)
      store.listConversations = () => [agentSessionConversationView(chat)]
      store.getVisibleSessionTabIndex = () => ({ present: true, sessionIds: openTabs })
      return store
    })
    registerPtyHandlers(mainWindow, runtime)
    return runtime
  }

  async function spawnResume(resumeOrigin?: 'saved', leafId = LEAF_ID) {
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
        command: `claude --resume '${C}'`,
        launchAgent: 'claude',
        resumeProviderSession: { key: 'session_id', id: C },
        ...(resumeOrigin ? { resumeOrigin } : {})
      })
      for (let flush = 0; flush < 3; flush += 1) {
        await Promise.resolve()
        vi.runAllTimers()
      }
      const env: Record<string, string> = spawnMock.mock.calls.at(-1)![2].env
      const typed = mockProc.proc.write.mock.calls.map((call) => String(call[0]))
      const reported = typeof result === 'object' && result !== null ? result : {}
      return {
        refused: 'agentResumeRefused' in reported ? reported.agentResumeRefused : undefined,
        notice: 'agentResumeUnavailable' in reported,
        input: [env[POSIX_SHELL_STARTUP_COMMAND_ENV] ?? '', ...typed].join('\n')
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
})
