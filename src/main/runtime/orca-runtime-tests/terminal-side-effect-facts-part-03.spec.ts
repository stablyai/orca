import { describe, expect, it } from 'vitest'
import './runtime-test-module-registration.spec'
import '../orca-runtime'
import { TEST_WORKTREE_ID, syncSinglePty } from './orca-runtime-test-fixtures.spec'
import { createSideEffectRuntime } from './orca-runtime-test-scenario-builders.spec'

describe('terminal side-effect fact channel', () => {
  it('emits command-code-working facts only after the banner arms the scrape', () => {
    const { runtime, batches } = createSideEffectRuntime()
    syncSinglePty(runtime)

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
})
