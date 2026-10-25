import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { OrcaRuntimeService } from './orca-runtime'
import { makeStore } from './runtime-rpc-worktree-store-fixtures'
import { spawnedPtyEnv } from './spawned-pty-env-fixtures'
import { committingSpawn } from './bind-first-pane.test-fixture'
import { partialRuntimeStore } from './runtime-store-partial-fixture'

// #10923: every OMP user bubble ends with OSC 133 `B C D;0`. Read as the shell's command
// finishing, that retired the pane's hook authority mid-turn, which deleted its status row and
// with it the provider session the phone's chat view addresses the transcript by.
const OMP_TRANSCRIPT = readFileSync(
  join(__dirname, '__fixtures__/omp-user-bubble-osc133-zone.txt'),
  'utf8'
)

vi.mock('../git/worktree', () => {
  const worktrees = [
    { path: '/tmp/worktree-omp', head: 'abc', branch: 'omp', isBare: false, isMainWorktree: false }
  ]
  return {
    listWorktrees: vi.fn().mockResolvedValue(worktrees),
    listWorktreesStrict: vi.fn().mockResolvedValue(worktrees)
  }
})

async function launchOmpPane(): Promise<{
  runtime: OrcaRuntimeService
  retire: ReturnType<typeof vi.fn>
  paneKey: string
}> {
  const retire = vi.fn()
  const spawn = vi.fn(async (_args: { worktreeId?: string; tabId?: string; leafId?: string }) => ({
    id: 'pty-omp',
    incarnationId: 'incarnation-1'
  }))
  const runtime = new OrcaRuntimeService(partialRuntimeStore(makeStore()), undefined, {
    attestAgentHookCompatibilityAuthority: (candidate) => ({
      paneKey: candidate.paneKey,
      source: 'current_hook' as const
    }),
    retireAgentHookCompatibilityAuthority: retire
  })
  runtime.setPtyController({
    spawn: committingSpawn(runtime, spawn),
    write: () => true,
    kill: () => true,
    getForegroundProcess: async () => 'omp'
  })
  await runtime.createTerminal('path:/tmp/worktree-omp', {
    command: 'omp',
    launchConfig: { agentCommand: 'omp', agentArgs: '', agentEnv: {} },
    launchAgent: 'omp'
  })
  return { runtime, retire, paneKey: spawnedPtyEnv(spawn.mock.calls[0]?.[0]).ORCA_PANE_KEY }
}

describe('OMP user bubbles and launch authority (#10923)', () => {
  it('keeps the pane authority through a real OMP turn', async () => {
    const { runtime, retire } = await launchOmpPane()
    let at = 100
    for (let index = 0; index < OMP_TRANSCRIPT.length; index += 512) {
      runtime.onPtyData('pty-omp', OMP_TRANSCRIPT.slice(index, index + 512), at++)
    }
    expect(retire).not.toHaveBeenCalled()
  })

  it('still retires it when the shell reports OMP exited', async () => {
    const { runtime, retire, paneKey } = await launchOmpPane()
    runtime.onPtyData('pty-omp', OMP_TRANSCRIPT, 100)
    runtime.onPtyData('pty-omp', '\x1b]133;D;0\x07\x1b]133;A\x07$ ', 101)
    expect(retire).toHaveBeenCalledWith(paneKey)
  })
})
