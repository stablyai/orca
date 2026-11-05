import type * as WorktreeScanCacheModule from '../../../git/worktrees/catalog/worktree-scan-cache'
import type * as WorktreeListingModule from '../../../git/worktrees/catalog/worktree-listing'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  buildAgentPromptPasteBytes,
  getTerminalPasteIngestMs
} from '../../../../shared/agent-launch/startup/agent-prompt-injection'

import { OrcaRuntimeService } from '../../orca-runtime'
import { makeStore } from '../../rpc/server/runtime-rpc-worktree-store-fixtures'

const WORKTREE_PATH = '/tmp/worktree-a'
const PTY_ID = 'pty-prompt'
// Stub the executing host; submit delay depends on host and payload, not just shell platform.
const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform')!

function useHostPlatform(platform: NodeJS.Platform): void {
  Object.defineProperty(process, 'platform', { configurable: true, value: platform })
}

vi.mock('../../../git/worktrees/catalog/worktree-scan-cache', async (importOriginal) => {
  const facade = getWorktreeListingMocks()
  return {
    ...(await importOriginal<typeof WorktreeScanCacheModule>()),
    listWorktrees: facade.listWorktrees
  }
})

vi.mock('../../../git/worktrees/catalog/worktree-listing', async (importOriginal) => {
  const facade = getWorktreeListingMocks()
  return {
    ...(await importOriginal<typeof WorktreeListingModule>()),
    listWorktreesStrict: facade.listWorktreesStrict
  }
})

const { getWorktreeListingMocks } = vi.hoisted(() => {
  const createWorktreeListingMocks = () => ({
    listWorktrees: vi.fn().mockResolvedValue([
      {
        path: '/tmp/worktree-a',
        head: 'abc',
        branch: 'feature/prompt-verification',
        isBare: false,
        isMainWorktree: false
      }
    ]),
    listWorktreesStrict: vi.fn().mockResolvedValue([
      {
        path: '/tmp/worktree-a',
        head: 'abc',
        branch: 'feature/prompt-verification',
        isBare: false,
        isMainWorktree: false
      }
    ])
  })
  let listings: ReturnType<typeof createWorktreeListingMocks> | undefined
  return { getWorktreeListingMocks: () => (listings ??= createWorktreeListingMocks()) }
})

// aider uses open-loop submission, exposing the delay under test.

// One 12KB chunk costs no write-loop time but separates ConPTY from fast-host delay.

/** Patch spawn-time execution-host state to exercise remote and WSL panes. */

function countSubmits(writes: readonly string[]): number {
  return writes.filter((data) => data === '\r').length
}

describe('agent prompt render gate on a ConPTY host', () => {
  afterEach(() => {
    vi.useRealTimers()
    Object.defineProperty(process, 'platform', originalPlatform)
  })

  /** Model a closed-loop agent repainting mid-ingest, then going quiet. */
  async function createSettlementRuntime(
    // Continuous noise forces the hard cap so its arithmetic can be measured.
    agentOutput: { markerDelayMs?: number; noiseUntilMs?: number } = {}
  ): Promise<{
    runtime: OrcaRuntimeService
    handle: string
    writes: string[]
    submitTimes: number[]
  }> {
    const markerDelayMs = agentOutput.markerDelayMs ?? 100
    const runtime = new OrcaRuntimeService(makeStore() as never)
    const writes: string[] = []
    const submitTimes: number[] = []
    const startedAt = Date.now()
    runtime.setPtyController({
      spawn: vi.fn().mockResolvedValue({ id: PTY_ID }),
      write: (_ptyId, data) => {
        writes.push(data)
        if (data === '\r') {
          submitTimes.push(Date.now() - startedAt)
        }
        if (data.includes('\x1b[201~')) {
          setTimeout(() => runtime.onPtyData(PTY_ID, '\x1b[?25h', Date.now()), markerDelayMs)
          for (let at = markerDelayMs + 500; at <= (agentOutput.noiseUntilMs ?? 0); at += 500) {
            setTimeout(() => runtime.onPtyData(PTY_ID, '.', Date.now()), at)
          }
        }
        return true
      },
      kill: () => true,
      getForegroundProcess: async () => null
    })
    const terminal = await runtime.createTerminal(`path:${WORKTREE_PATH}`, {
      launchAgent: 'claude'
    })
    return { runtime, handle: terminal.handle, writes, submitTimes }
  }

  it('does not let a mid-ingest marker plus quiet settle a large paste early', async () => {
    useHostPlatform('win32')
    vi.useFakeTimers()
    const { runtime, handle, writes, submitTimes } = await createSettlementRuntime()
    const submission = runtime.sendTerminalAgentPrompt(handle, 'y'.repeat(320_000), {
      inputKind: 'driving'
    })
    const stalled = expect(submission).rejects.toThrow('agent_prompt_stalled')

    // 100ms marker plus 1500ms quiet would submit before measured 2969–3342ms ingest completes.
    await vi.advanceTimersByTimeAsync(3_342)
    expect(writes.filter((data) => data.includes('\x1b[201~'))).toHaveLength(1)
    expect(countSubmits(writes)).toBe(0)

    await vi.runAllTimersAsync()
    expect(submitTimes).toHaveLength(1)
    expect(submitTimes[0]).toBeGreaterThan(3_342)
    await stalled
  })

  it('caps a never-quiet pane at one ingest window past the render timeout', async () => {
    useHostPlatform('win32')
    vi.useFakeTimers()
    const prompt = 'y'.repeat(320_000)
    const ingestMs = getTerminalPasteIngestMs(
      'win32',
      Buffer.byteLength(buildAgentPromptPasteBytes(prompt), 'utf8')
    )
    // A mid-ingest marker rearms the cap; do not charge ingest time twice.
    const { runtime, handle, writes, submitTimes } = await createSettlementRuntime({
      markerDelayMs: ingestMs - 1_000,
      noiseUntilMs: ingestMs + 20_000
    })
    const submission = runtime.sendTerminalAgentPrompt(handle, prompt, { inputKind: 'driving' })
    const stalled = expect(submission).rejects.toThrow('agent_prompt_stalled')

    await vi.advanceTimersByTimeAsync(ingestMs + 8_000 - 1)
    expect(countSubmits(writes)).toBe(0)

    await vi.runAllTimersAsync()
    expect(submitTimes).toHaveLength(1)
    expect(submitTimes[0]).toBeGreaterThanOrEqual(ingestMs + 8_000)
    expect(submitTimes[0]).toBeLessThan(ingestMs + 8_500)
    await stalled
  })
})
