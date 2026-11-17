import { afterEach, expect, it, vi } from 'vitest'
import './runtime-test-module-registration.spec'
import { OrcaRuntimeService } from '../orca-runtime'
import {
  TEST_WORKTREE_ID,
  TEST_WORKTREE_PATH,
  makeWorktreeInfo,
  store
} from './orca-runtime-test-fixtures.spec'

afterEach(() => vi.useRealTimers())

it.each([
  { exitCode: 0, replace: false },
  { exitCode: 7, replace: false },
  { exitCode: 0, replace: true }
])(
  'keeps an adopted linked draft tied to Setup outcome $exitCode, replacement $replace',
  async ({ exitCode, replace }) => {
    vi.useFakeTimers()
    const metadata = {
      ...store.getAllWorktreeMeta()[TEST_WORKTREE_ID],
      instanceId: 'linked-issue-instance'
    }
    const runtime = new OrcaRuntimeService({ ...store, getWorktreeMeta: () => metadata })
    const writes: { ptyId: string; data: string }[] = []
    let setupPtyId = ''
    let setupToken = ''
    let nextPty = 0
    runtime.setPtyController({
      spawn: async (options) => {
        const id = options.sessionId ?? `linked-issue-pty-${nextPty++}`
        const script = options.env?.ORCA_SEQUENCED_SETUP_SCRIPT
        if (script) {
          setupPtyId = id
          setupToken = /__ORCA_SETUP_COMPLETE__:([^:]+):/.exec(script)?.[1] ?? ''
        }
        return { id, incarnationId: 'original-process' }
      },
      write: (ptyId, data) => {
        writes.push({ ptyId, data })
        return true
      },
      kill: () => true,
      getForegroundProcess: async () => 'codex'
    })
    const worktree = {
      ...makeWorktreeInfo(TEST_WORKTREE_PATH),
      ...metadata,
      id: TEST_WORKTREE_ID,
      repoId: 'repo-1'
    }
    const started = await runtime.startCreatedWorktreeTerminals({
      repo: store.getRepos()[0]!,
      worktree,
      request: {
        repoSelector: 'id:repo-1',
        name: 'linked-issue',
        activate: false,
        startup: { command: 'codex' },
        createdWithAgent: 'codex',
        startupDraftPaste: { agent: 'codex', content: 'Repair the linked issue' }
      },
      setup: { runnerScriptPath: '/tmp/setup.sh', envVars: {}, waitForAgentStartup: true }
    })
    const agentPtyId = started.startupTerminalPtyId!
    const admission = await runtime.prepareTerminalSetupForSpawn({
      workspaceId: worktree.id,
      command: 'codex',
      agent: 'codex',
      shell: 'posix'
    })
    admission?.bind(agentPtyId)
    runtime.attachWindow(1)
    await runtime.syncWindowGraph(1, {
      tabs: [
        {
          tabId: 'linked-issue-tab',
          worktreeId: worktree.id,
          title: 'Linked issue',
          activeLeafId: 'linked-issue-pane',
          layout: null
        }
      ],
      leaves: [
        {
          tabId: 'linked-issue-tab',
          worktreeId: worktree.id,
          leafId: 'linked-issue-pane',
          paneRuntimeId: 1,
          ptyId: agentPtyId
        }
      ]
    })
    await vi.advanceTimersByTimeAsync(35_000)
    expect(writes).toEqual([])
    expect(setupToken).not.toBe('')
    runtime.onPtyData(
      setupPtyId,
      `\x1b]777;__ORCA_SETUP_COMPLETE__:${setupToken}:${exitCode}\x07`,
      100
    )
    await vi.advanceTimersByTimeAsync(0)
    if (replace) {
      runtime.onPtySpawned(agentPtyId, 'replacement-process', { awaitsRegistration: false })
    }
    runtime.onPtyData(agentPtyId, '\x1b[?2004h\x1b[?25h› ', 101)
    await vi.advanceTimersByTimeAsync(0)
    if (replace) {
      expect(writes).toEqual([])
    } else if (exitCode === 0) {
      expect(writes).toEqual([
        { ptyId: agentPtyId, data: '\x1b[200~Repair the linked issue\x1b[201~' }
      ])
      await expect(
        runtime.waitForTerminalSetup(started.startupTerminalHandle!, 'Codex')
      ).resolves.toBeUndefined()
    } else {
      expect(writes).toEqual([])
      await expect(
        runtime.waitForTerminalSetup(started.startupTerminalHandle!, 'Codex')
      ).rejects.toThrow('Setup did not finish successfully')
    }
  }
)
