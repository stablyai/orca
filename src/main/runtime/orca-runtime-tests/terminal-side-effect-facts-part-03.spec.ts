import { describe, expect, it, vi } from 'vitest'
import { TEST_WORKTREE_ID, syncSinglePty } from '../orca-runtime-test-fixtures.spec'
import { createSideEffectRuntime } from '../orca-runtime-test-scenario-builders.spec'
import '../orca-runtime-test-mocks.spec'

describe('terminal side-effect fact channel', () => {
  it('arms the stale-title timer for a seeded working title', async () => {
    vi.useFakeTimers()
    try {
      const { runtime, batches } = createSideEffectRuntime()
      const serializeBuffer = vi.fn().mockResolvedValue({
        data: 'restored scrollback\n',
        cols: 80,
        rows: 24,
        lastTitle: 'Codex working'
      })
      runtime.setPtyController({
        write: () => true,
        kill: () => true,
        getForegroundProcess: async () => null,
        serializeBuffer,
        hasRendererSerializer: () => true,
        getSize: () => ({ cols: 80, rows: 24 })
      })
      syncSinglePty(runtime)

      runtime.onPtyData('pty-1', 'plain output\n', 100)
      // Settle the async daemon-snapshot hydration that seeds the tracker.
      await vi.advanceTimersByTimeAsync(0)
      runtime.onPtyData('pty-1', 'still no title\n', 101)
      batches.length = 0

      await vi.advanceTimersByTimeAsync(3_000)

      expect(batches.flatMap((batch) => batch.facts)).toEqual([
        {
          kind: 'title',
          normalizedTitle: 'Codex',
          rawTitle: 'Codex',
          staleWorkingTitleClear: true
        },
        { kind: 'agent-idle', title: 'Codex', staleWorkingTitleClear: true }
      ])
    } finally {
      vi.useRealTimers()
    }
  })

  it('emits command-code-working facts only after the banner arms the scrape', () => {
    const { runtime, batches } = createSideEffectRuntime()
    syncSinglePty(runtime)

    // Generic status words without the Command Code banner must not arm.
    runtime.onPtyData('pty-1', '❯ Fix the spinner\r\nThinking...', 100)
    expect(batches.flatMap((batch) => batch.facts)).toEqual([])

    runtime.onPtyData('pty-1', '# Command Code v0.27.3\r\n', 101)
    runtime.onPtyData('pty-1', '❯ Fix the spinner\r\n\x1b[35m✻ Thinking...\x1b[0m', 102)

    expect(batches.at(-1)).toMatchObject({
      ptyId: 'pty-1',
      worktreeId: TEST_WORKTREE_ID,
      tabId: 'tab-1'
    })
    expect(batches.at(-1)?.facts).toEqual([
      { kind: 'command-code-working', prompt: 'Fix the spinner' }
    ])
  })

  it('emits a command-code-done fact when the idle composer returns', () => {
    const { runtime, batches } = createSideEffectRuntime()
    syncSinglePty(runtime)

    runtime.onPtyData('pty-1', '# Command Code v0.27.3\r\n', 100)
    runtime.onPtyData('pty-1', '❯ say hi\r\n✻ Thinking...', 101)
    runtime.onPtyData(
      'pty-1',
      '\r\n✻ Thought for 1 second\r\n:: Hi!\r\n❯ Ask your question...',
      102
    )

    expect(batches.at(-1)?.facts).toEqual([{ kind: 'command-code-done', prompt: 'say hi' }])
  })

  it('arms the Command Code scrape from the noted spawn command', () => {
    const { runtime, batches } = createSideEffectRuntime()
    syncSinglePty(runtime)

    // Mirrors the renderer detector's startupCommand fast-arm: no banner needed when main saw the launch command at spawn.
    runtime.noteTerminalSpawnCommand('pty-1', 'command-code --trust')
    runtime.onPtyData('pty-1', '❯ Fix the spinner\r\n✻ Thinking...', 100)

    expect(batches.flatMap((batch) => batch.facts)).toContainEqual({
      kind: 'command-code-working',
      prompt: 'Fix the spinner'
    })
  })

  it('prefers the tracked title over a stale renderer lastTitle in the hydration seed', async () => {
    const { runtime } = createSideEffectRuntime()
    const serializeBuffer = vi.fn().mockResolvedValue({
      data: 'renderer scrollback\n',
      cols: 80,
      rows: 24,
      // Renderer xterm never saw the synthetic hook frame (no longer rides pty:data), so its serializer reports the pre-agent title.
      lastTitle: 'stale shell title'
    })
    runtime.setPtyController({
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => null,
      serializeBuffer,
      hasRendererSerializer: () => true,
      getSize: () => ({ cols: 80, rows: 24 })
    })
    syncSinglePty(runtime)

    runtime.ingestSyntheticTitleFrame('pty-1', '\x1b]0;⠋ Claude working\x07')
    // First live chunk kicks off renderer hydration; awaiting the snapshot below settles the seed write chain.
    runtime.onPtyData('pty-1', 'plain output\n', 100)
    await runtime.serializeMainTerminalBuffer('pty-1', { scrollbackRows: 10 })

    const leaves = (runtime as unknown as { leaves: Map<string, { lastOscTitle: string | null }> })
      .leaves
    // The seed must not stomp the leaf record (worktree ps status source) back to the renderer's stale title.
    expect([...leaves.values()][0]?.lastOscTitle).toBe('⠋ Claude working')
  })
})
