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
    agentOutput: {
      markerDelayMs?: number
      noiseUntilMs?: number
      composer?: string
      noise?: string
    } = {}
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
          const frame = agentOutput.composer ? `\x1b[H\x1b[2J${agentOutput.composer}` : ''
          setTimeout(
            () => runtime.onPtyData(PTY_ID, `${frame}\x1b[?25h`, Date.now()),
            markerDelayMs
          )
          for (let at = markerDelayMs + 500; at <= (agentOutput.noiseUntilMs ?? 0); at += 500) {
            setTimeout(() => runtime.onPtyData(PTY_ID, agentOutput.noise ?? '.', Date.now()), at)
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

  describe('with child work repainting forever', () => {
    const prompt = 'review the background agent output and report'
    const rule = '\u2500'.repeat(40)
    // Claude parks the cursor at the end of its composer line.
    const composer = (text: string): string =>
      `\x1b[H\x1b[2J${rule}\r\n\u276f ${text}\r\n${rule}\x1b[2;${text.length + 3}H`
    // A dim suggestion with the cursor parked before it, as Claude paints one in an empty composer.
    const suggesting = (text: string): string =>
      `\x1b[H\x1b[2J${rule}\r\n\u276f \x1b[2m${text}\x1b[22m\r\n${rule}\x1b[2;3H`

    async function submitTime(shown: { before: string; after: string }): Promise<number> {
      const { runtime, handle, submitTimes } = await createSettlementRuntime({
        noiseUntilMs: 20_000,
        // A progress row repainting elsewhere leaves the composer and its cursor as they were.
        noise: '\x1b7\x1b[5;1Hworking\x1b8',
        composer: shown.after.slice('\x1b[H\x1b[2J'.length)
      })
      runtime.onPtyData(PTY_ID, shown.before, Date.now())
      const submission = runtime.sendTerminalAgentPrompt(handle, prompt, { inputKind: 'driving' })
      const stalled = expect(submission).rejects.toThrow('agent_prompt_stalled')
      await vi.runAllTimersAsync()
      await stalled
      expect(submitTimes).toHaveLength(1)
      return submitTimes[0]
    }

    it('submits once an empty composer keeps showing the whole paste', async () => {
      useHostPlatform('win32')
      vi.useFakeTimers()
      // Marker at 100ms plus the settle window, well before the 1.5s quiet window or 8s cap.
      const at = await submitTime({ before: composer(''), after: composer(prompt) })
      expect(at).toBeGreaterThanOrEqual(400)
      expect(at).toBeLessThan(1_500)
    })

    it.each([
      [
        'only the end of the paste is shown',
        { before: composer(''), after: composer(prompt.slice(8)) }
      ],
      [
        'the composer already held the prompt',
        { before: composer(prompt), after: composer(prompt) }
      ],
      [
        'a dim suggestion already showed the prompt',
        { before: suggesting(prompt), after: suggesting(prompt) }
      ]
    ])('waits for the cap when %s', async (_case, shown) => {
      useHostPlatform('win32')
      vi.useFakeTimers()
      expect(await submitTime(shown)).toBeGreaterThanOrEqual(8_000)
    })
  })
})
