import { describe, expect, it, vi } from 'vitest'
import { syncSinglePty } from '../orca-runtime-test-fixtures.spec'
import { createSideEffectRuntime } from '../orca-runtime-test-scenario-builders.spec'

describe('terminal agent exit evidence', () => {
  it.each([
    { label: 'unavailable process', process: null },
    { label: 'empty process', process: '' },
    { label: 'unrecognized wrapper', process: 'node.exe' }
  ])('keeps Codex chat on $label and still detects a later shell', async ({ process }) => {
    const { runtime, batches } = createSideEffectRuntime()
    syncSinglePty(runtime)
    runtime.ingestSyntheticTitleFrame('pty-1', '\x1b]0;Codex ready\x07')
    const getForegroundProcess = vi
      .fn()
      .mockResolvedValueOnce(process)
      .mockResolvedValue('bash.exe')
    runtime.setPtyController({ write: () => true, kill: () => true, getForegroundProcess })

    runtime.onPtyData('pty-1', '\x1b]0;workspace\x07', 100)
    await vi.waitFor(() => expect(getForegroundProcess).toHaveBeenCalledOnce())
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(batches.flatMap((batch) => batch.facts)).not.toContainEqual({ kind: 'agent-exited' })

    runtime.onPtyData('pty-1', '\x1b]0;other workspace\x07', 101)
    await vi.waitFor(() =>
      expect(batches.flatMap((batch) => batch.facts)).toContainEqual({ kind: 'agent-exited' })
    )
  })

  it('keeps chat when the host has no foreground inspection capability', async () => {
    const { runtime, batches } = createSideEffectRuntime()
    syncSinglePty(runtime)
    runtime.setPtyController(null)
    runtime.ingestSyntheticTitleFrame('pty-1', '\x1b]0;Codex ready\x07')
    runtime.onPtyData('pty-1', '\x1b]0;workspace\x07', 100)
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(batches.flatMap((batch) => batch.facts)).not.toContainEqual({ kind: 'agent-exited' })
  })

  it('ignores an old host controller result after reconnect', async () => {
    const { runtime, batches } = createSideEffectRuntime()
    syncSinglePty(runtime)
    let resolveRead: (process: string) => void = () => {}
    const getForegroundProcess = vi.fn(
      () =>
        new Promise<string>((resolve) => {
          resolveRead = resolve
        })
    )
    runtime.setPtyController({ write: () => true, kill: () => true, getForegroundProcess })
    runtime.ingestSyntheticTitleFrame('pty-1', '\x1b]0;Codex ready\x07')
    runtime.onPtyData('pty-1', '\x1b]0;workspace\x07', 100)
    await vi.waitFor(() => expect(getForegroundProcess).toHaveBeenCalledOnce())
    runtime.setPtyController({
      write: () => true,
      kill: () => true,
      getForegroundProcess: async () => 'codex'
    })
    resolveRead('bash.exe')
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(batches.flatMap((batch) => batch.facts)).not.toContainEqual({ kind: 'agent-exited' })
  })
})
