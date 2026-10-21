import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import type * as ShellAloneModule from './run-terminal-shell-alone'
import { OrcaRuntimeService } from './orca-runtime'
import { makeStore } from './runtime-rpc-worktree-store-fixtures'
import { spawnedPtyEnv } from './spawned-pty-env-fixtures'

// #10923: every OMP user bubble ends with OSC 133 `B C D;0`. Read as the shell's command
// finishing, that retired the pane's hook authority mid-turn, which deleted its status row and
// with it the provider session the phone's chat view addresses the transcript by.
const OMP_TRANSCRIPT = readFileSync(
  join(__dirname, '__fixtures__/omp-user-bubble-osc133-zone.txt'),
  'utf8'
)

const D0 = '\x1b]133;D;0\x07'
const BUBBLE_CLOSE = `\x1b]133;B\x07\x1b]133;C\x07${D0}`

// OMP hook rows carry no process identity, so the shell's process tree decides.
const shellAlone = vi.hoisted(() => vi.fn(async () => true))
vi.mock('./run-terminal-shell-alone', async (importOriginal) => ({
  ...(await importOriginal<typeof ShellAloneModule>()),
  confirmRootShellHasNoChildrenFromProcessTable: shellAlone
}))

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
  shellAlone.mockReset().mockResolvedValue(false)
  const spawn = vi.fn().mockResolvedValue({ id: 'pty-omp', incarnationId: 'incarnation-1' })
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: makeStore serves the repo reads terminal creation makes; the rest of Store is unreached.
  const runtime = new OrcaRuntimeService(makeStore() as never, undefined, {
    attestAgentHookCompatibilityAuthority: (candidate) => ({
      paneKey: candidate.paneKey,
      source: 'current_hook' as const
    }),
    retireAgentHookCompatibilityAuthority: retire
  })
  runtime.setPtyController({
    spawn,
    write: () => true,
    kill: () => true,
    getForegroundProcess: async () => 'omp',
    listProcesses: async () => [
      { id: 'pty-omp', rootProcessId: 4242, cwd: '/tmp/worktree-omp', title: 'omp' }
    ]
  })
  await runtime.createTerminal('path:/tmp/worktree-omp', {
    command: 'omp',
    launchConfig: { agentCommand: 'omp', agentArgs: '', agentEnv: {} },
    launchAgent: 'omp'
  })
  return {
    runtime,
    retire,
    paneKey: spawnedPtyEnv(spawn.mock.calls[0]?.[0]).ORCA_PANE_KEY
  }
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

  it("keeps it when the pane is shown between a bubble's B C and its D", async () => {
    const { runtime, retire } = await launchOmpPane()
    const zoneEnd = OMP_TRANSCRIPT.indexOf(BUBBLE_CLOSE) + BUBBLE_CLOSE.length - D0.length
    runtime.setPtyTransientFactDelegation('pty-omp', true)
    runtime.onPtyData('pty-omp', OMP_TRANSCRIPT.slice(0, zoneEnd), 100)
    runtime.setPtyTransientFactDelegation('pty-omp', false)
    runtime.onPtyData('pty-omp', OMP_TRANSCRIPT.slice(zoneEnd), 101)
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(retire).not.toHaveBeenCalled()
    expect(shellAlone).not.toHaveBeenCalled()
  })

  it("keeps it when an old daemon reports a hidden bubble's D as a finished command", async () => {
    const { runtime, retire } = await launchOmpPane()
    const zoneEnd = OMP_TRANSCRIPT.indexOf(BUBBLE_CLOSE) + BUBBLE_CLOSE.length - D0.length
    runtime.onPtyData('pty-omp', OMP_TRANSCRIPT.slice(0, zoneEnd), 100)
    runtime.setPtyTransientFactDelegation('pty-omp', true)
    runtime.emitDaemonPtyTransientFact('pty-omp', { kind: 'command-finished', exitCode: 0 })
    await vi.waitFor(() => expect(shellAlone).toHaveBeenCalledWith(4242))
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(retire).not.toHaveBeenCalled()
  })

  it("keeps it when the dropped output held a bubble's B C", async () => {
    const { runtime, retire } = await launchOmpPane()
    const zoneStart = OMP_TRANSCRIPT.indexOf(BUBBLE_CLOSE)
    runtime.onPtyData('pty-omp', OMP_TRANSCRIPT.slice(0, zoneStart), 100)
    runtime.notePtyDataGap('pty-omp', BUBBLE_CLOSE.length - D0.length)
    runtime.onPtyData(
      'pty-omp',
      OMP_TRANSCRIPT.slice(zoneStart + BUBBLE_CLOSE.length - D0.length),
      101
    )
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(retire).not.toHaveBeenCalled()
    expect(shellAlone).not.toHaveBeenCalled()
  })

  it('still retires it when the shell reports OMP exited', async () => {
    const { runtime, retire, paneKey } = await launchOmpPane()
    runtime.onPtyData('pty-omp', OMP_TRANSCRIPT, 100)
    shellAlone.mockResolvedValue(true)
    runtime.onPtyData('pty-omp', '\x1b]133;D;0\x07\x1b]133;A\x07$ ', 101)
    await vi.waitFor(() => expect(retire).toHaveBeenCalledWith(paneKey))
  })
})
