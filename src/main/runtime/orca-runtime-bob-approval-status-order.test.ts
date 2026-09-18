import { describe, expect, it, vi } from 'vitest'
import { OrcaRuntimeService } from './orca-runtime'

vi.mock('electron', () => ({
  BrowserWindow: { fromId: vi.fn(() => null) },
  webContents: { fromId: vi.fn(() => null) },
  ipcMain: { on: vi.fn(), removeListener: vi.fn() },
  app: { getPath: vi.fn(() => '/tmp') }
}))

const WORKTREE_ID = 'wt-bob'
const PTY_ID = 'pty-bob'

describe('Bob approval status ordering', () => {
  // Why: the modal is still on screen, so a same-chunk OSC status must not overwrite `waiting`.
  it('emits the approval waiting after the chunk’s own OSC statuses', async () => {
    const states: string[] = []
    const runtime = new OrcaRuntimeService(null, undefined, {
      onTerminalAgentStatus: (event) => {
        states.push(event.payload.state)
      }
    })
    vi.spyOn(
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: Protected runtime seam; vi.spyOn throws if the method is renamed.
      runtime as unknown as { resolveTerminalWorkspaceLaunchScope: () => Promise<unknown> },
      'resolveTerminalWorkspaceLaunchScope'
    ).mockResolvedValue({
      id: WORKTREE_ID,
      path: '/repo/app',
      connectionId: null,
      repo: null,
      folderWorkspace: null
    })
    runtime.setPtyController({
      spawn: vi.fn().mockResolvedValue({ id: PTY_ID }),
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => null
    })
    await runtime.createTerminal(`id:${WORKTREE_ID}`, {
      tabId: 'tab-bob',
      leafId: '33333333-3333-4333-8333-333333333333',
      title: 'Terminal'
    })

    runtime.onPtyData(
      PTY_ID,
      [
        '  ❯   Build Anything, @ for context, / for commands, $ for skills\r\n',
        '  Execute Command\r\n  Approve commands:\r\n',
        '\x1b]9999;{"state":"working","prompt":"","agentType":"bob"}\x07',
        '  → Approve Once\r\n    Reject\r\n'
      ].join(''),
      Date.now()
    )

    expect(states).toEqual(['working', 'waiting'])
  })
})
