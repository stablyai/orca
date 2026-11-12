import { describe, expect, it, vi } from 'vitest'
import { committingSpawn } from './bind-first-pane.test-fixture'
import './runtime-test-module-registration.spec'
import { OrcaRuntimeService } from '../orca-runtime'
import '../../../shared/workspace-layout/stable-pane-id'
import type { RuntimeTerminalAgentStatusEvent } from '../terminal/output/terminal-agent-status-events'
import {
  TEST_WORKTREE_ID,
  TEST_WORKTREE_PATH,
  expectStablePaneKeyEnv,
  store
} from './orca-runtime-test-fixtures.spec'
import { spawnedPtyEnv } from '../terminal/launch/spawned-pty-env-fixtures'

describe('OrcaRuntimeService', () => {
  it('preserves OSC 9999 parser state for rendererless background PTYs', async () => {
    const statuses: RuntimeTerminalAgentStatusEvent[] = []
    const spawn = vi.fn().mockResolvedValue({ id: 'pty-bg' })
    const runtime = new OrcaRuntimeService(store, undefined, {
      onTerminalAgentStatus: (event) => statuses.push(event)
    })
    runtime.setPtyController({
      spawn: committingSpawn(runtime, spawn),
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => null
    })

    await runtime.createTerminal(`path:${TEST_WORKTREE_PATH}`, {
      command: 'codex',
      title: 'worker'
    })
    const spawnedEnv = spawnedPtyEnv(spawn.mock.calls[0]?.[0])
    const paneKey = expectStablePaneKeyEnv(spawnedEnv)

    runtime.onPtyData('pty-bg', 'before\x1b]999', 123)
    runtime.onPtyData('pty-bg', '9;{"state":"done","prompt":"ok"}\x1b\\after', 124)

    expect(statuses).toEqual([
      {
        ptyId: 'pty-bg',
        source: 'pty-record',
        paneKey,
        tabId: spawnedEnv.ORCA_TAB_ID,
        worktreeId: TEST_WORKTREE_ID,
        connectionId: null,
        terminalHandle: expect.stringMatching(/^term_/),
        payload: {
          state: 'done',
          prompt: 'ok'
        }
      }
    ])
  })

  it('keeps blocked prompt text authoritative over an OpenCode marker', async () => {
    const runtime = new OrcaRuntimeService(store)
    runtime.setPtyController({
      spawn: vi.fn().mockResolvedValue({ id: 'pty-1' }),
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => 'opencode'
    })
    const leafId = '11111111-1111-4111-8111-111111111111'
    runtime.attachWindow(1)
    runtime.syncWindowGraph(1, {
      tabs: [
        {
          tabId: 'tab-1',
          worktreeId: TEST_WORKTREE_ID,
          title: 'OC | Native session',
          activeLeafId: leafId,
          layout: null
        }
      ],
      leaves: [
        {
          tabId: 'tab-1',
          worktreeId: TEST_WORKTREE_ID,
          leafId,
          paneRuntimeId: 1,
          ptyId: 'pty-1',
          paneTitle: 'OC | Native session'
        }
      ]
    })
    runtime.onPtyData(
      'pty-1',
      'Permission required\nThis command requires permission\nAllow once\nAllow always\nReject\n',
      123
    )
    const [terminal] = (await runtime.listTerminals()).terminals

    await expect(runtime.getTerminalAgentStatus(terminal.handle)).resolves.toEqual({
      handle: terminal.handle,
      isRunningAgent: true,
      status: 'permission'
    })
    await expect(
      runtime.waitForTerminal(terminal.handle, { condition: 'tui-idle', timeoutMs: 1_000 })
    ).resolves.toMatchObject({
      satisfied: false,
      blockedReason: 'agent-interactive-prompt'
    })
  })
})
