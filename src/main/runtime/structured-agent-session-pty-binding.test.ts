import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  agentSessionLeaseFixture,
  agentSessionRecordFixture
} from '../../shared/agent-session-record.test-fixture'
import { agentSessionPtyWriteGate } from './agent-session-pty-write-gate'
import { OrcaRuntimeService } from './orca-runtime'

vi.mock('electron', () => ({
  BrowserWindow: { fromId: vi.fn(() => null) },
  webContents: { fromId: vi.fn(() => null) },
  ipcMain: { on: vi.fn(), removeListener: vi.fn() },
  app: { getPath: vi.fn(() => '/tmp') }
}))

const SESSION_ID = 'structured-session-1'

afterEach(() => agentSessionPtyWriteGate.detachRecordLookup())

describe('structured handoff PTY binding', () => {
  it('binds before runtime writes and unbinds on process exit', async () => {
    const runtime = new OrcaRuntimeService()
    const internal = runtime as unknown as {
      resolveTerminalWorkspaceLaunchScope: (selector: string) => Promise<{
        id: string
        path: string
        connectionId: null
        repo: null
        folderWorkspace: null
      }>
    }
    vi.spyOn(internal, 'resolveTerminalWorkspaceLaunchScope').mockResolvedValue({
      id: 'worktree-1',
      path: '/tmp/worktree-1',
      connectionId: null,
      repo: null,
      folderWorkspace: null
    })
    const write = vi.fn(() => true)
    runtime.setPtyController({
      spawn: vi.fn(async () => ({ id: 'pty-structured', pid: 4200 })),
      write,
      kill: () => true,
      getForegroundProcess: async () => null
    })
    const record = agentSessionRecordFixture(
      agentSessionLeaseFixture({
        sessionId: SESSION_ID,
        runtimeKind: 'native',
        handoffStage: 'new-owner-proving'
      })
    )
    agentSessionPtyWriteGate.attachRecordLookup((sessionId) =>
      sessionId === SESSION_ID ? record : null
    )

    await runtime.createTerminal('id:worktree-1', {
      command: 'codex resume thread-1',
      structuredAgentSessionId: SESSION_ID
    })

    expect(agentSessionPtyWriteGate.boundSessionId('pty-structured')).toBe(SESSION_ID)
    await expect(runtime.writeTerminalPreviewInput('pty-structured', 'unsafe')).resolves.toBe(false)
    expect(write).not.toHaveBeenCalled()

    runtime.onPtyExit('pty-structured', 0)
    expect(agentSessionPtyWriteGate.boundSessionId('pty-structured')).toBeNull()
  })
})
