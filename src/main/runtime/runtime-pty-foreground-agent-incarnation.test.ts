import { describe, expect, it, vi } from 'vitest'
import { RuntimePtyForegroundAgent } from './runtime-pty-foreground-agent'
import type { RuntimePtyController } from './runtime-pty-controller-contract'
import type { RuntimePtyWorktreeRecord } from './runtime-terminal-state-records'

describe('foreground process observation ownership', () => {
  it('retires pending predecessor reads and independently observes the replacement', async () => {
    let resolvePredecessor!: (value: string) => void
    const predecessor = new Promise<string>((resolve) => {
      resolvePredecessor = resolve
    })
    const controller = {
      getForegroundProcess: vi.fn().mockReturnValueOnce(predecessor).mockResolvedValue('codex')
    } as unknown as RuntimePtyController
    const pty = {
      connected: true,
      launchAgent: null,
      foregroundAgent: null
    } as RuntimePtyWorktreeRecord
    const touchSnapshot = vi.fn()
    const observer = new RuntimePtyForegroundAgent({
      getController: () => controller,
      getPty: () => pty,
      touchSnapshot,
      finishDelayedSnapshot: vi.fn()
    })
    const oldRefresh = observer.refresh('synthetic')
    observer.resetIncarnation('synthetic')
    expect(await observer.refresh('synthetic')).toBe(true)
    expect(pty.foregroundAgent).toBe('codex')
    resolvePredecessor('claude')
    expect(await oldRefresh).toBe(false)
    expect(pty.foregroundAgent).toBe('codex')
    expect(touchSnapshot).toHaveBeenCalledTimes(1)
    expect(controller.getForegroundProcess).toHaveBeenCalledTimes(2)
  })
})
