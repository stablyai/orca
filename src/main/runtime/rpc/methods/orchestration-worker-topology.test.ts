import { describe, expect, it, vi } from 'vitest'

import type { OrcaRuntimeService } from '../../orca-runtime'
import { createExistingWorktreeWorkerTerminal } from './orchestration-worker-topology'

function runtimeStub(launchCommand: string) {
  return {
    resolveTuiAgentLaunchCommand: vi.fn().mockResolvedValue(launchCommand),
    createTerminal: vi.fn().mockResolvedValue({ handle: 'handle-1', surface: 'background' })
  } as unknown as OrcaRuntimeService
}

describe('createExistingWorktreeWorkerTerminal', () => {
  it('spawns the resolved launch command instead of the raw agent id', async () => {
    // Regression: `command: args.agent` ran the agent id as a shell command, so on
    // Windows `cursor` resolved to Cursor IDE's cursor.cmd and opened the desktop app.
    const runtime = runtimeStub('cursor-agent')

    await createExistingWorktreeWorkerTerminal({
      runtime,
      worktreeId: 'wt-1',
      agent: 'cursor',
      taskId: 'task-1',
      effects: []
    })

    expect(runtime.resolveTuiAgentLaunchCommand).toHaveBeenCalledWith('id:wt-1', 'cursor')
    expect(runtime.createTerminal).toHaveBeenCalledWith(
      'id:wt-1',
      expect.objectContaining({ command: 'cursor-agent' })
    )
  })
})
