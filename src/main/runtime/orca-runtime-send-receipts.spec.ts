import { TEST_WORKTREE_PATH, store } from './orca-runtime-test-fixtures.spec'
import { describe, expect, it, vi } from 'vitest'
import { OrcaRuntimeService } from './orca-runtime'
import { buildAgentPromptPasteBytes } from '../../shared/agent-prompt-injection'

describe('OrcaRuntimeService', () => {
  it('uses a supplied stable runtime identity for durable ownership journals', () => {
    const runtime = new OrcaRuntimeService(null, undefined, { runtimeId: 'profile-runtime-1' })

    expect(runtime.getRuntimeId()).toBe('profile-runtime-1')
  })

  it('deduplicates a receipted agent prompt and forwards stable provider operation IDs', async () => {
    vi.useFakeTimers()
    try {
      const writes: string[] = []
      const operationIds: (string | undefined)[] = []
      const runtime = new OrcaRuntimeService(store)
      runtime.setPtyController({
        spawn: vi.fn().mockResolvedValue({ id: 'pty-bg' }),
        write: (_ptyId, data, retry) => {
          writes.push(data)
          operationIds.push(retry?.operationId)
          acknowledgeAgentPromptSubmit(runtime, 'pty-bg', data)
          return true
        },
        kill: () => true,
        getForegroundProcess: async () => null
      })
      const { handle } = await runtime.createTerminal(`path:${TEST_WORKTREE_PATH}`)

      const first = runtime.sendTerminalAgentPrompt(handle, 'review this', {
        operationId: 'agent-prompt-op-1'
      })
      await vi.runAllTimersAsync()
      await expect(first).resolves.toMatchObject({ handle, accepted: true })
      await expect(
        runtime.sendTerminalAgentPrompt(handle, 'review this', {
          operationId: 'agent-prompt-op-1'
        })
      ).resolves.toMatchObject({ handle, accepted: true })

      expect(writes).toEqual([buildAgentPromptPasteBytes('review this'), '\r'])
      expect(operationIds).toEqual(['agent-prompt-op-1', 'agent-prompt-op-1:suffix'])
    } finally {
      vi.useRealTimers()
    }
  })

  it('passes stable terminal.send operation identities to provider writes', async () => {
    const retries: ({ operationId: string } | undefined)[] = []
    const runtime = new OrcaRuntimeService(store)
    runtime.setPtyController({
      spawn: vi.fn().mockResolvedValue({ id: 'pty-bg' }),
      write: (_ptyId, _data, retry) => {
        retries.push(retry)
        return true
      },
      kill: () => true,
      getForegroundProcess: async () => null
    })
    const { handle } = await runtime.createTerminal(`path:${TEST_WORKTREE_PATH}`)

    await expect(
      runtime.sendTerminal(handle, { text: 'payload' }, { operationId: 'paste-op-1' })
    ).resolves.toMatchObject({ handle, accepted: true })

    expect(retries).toEqual([{ operationId: 'paste-op-1' }])
  })

  it('deduplicates a repeated terminal.send operation after an ambiguous reply', async () => {
    const writes: string[] = []
    const runtime = new OrcaRuntimeService(store)
    runtime.setPtyController({
      spawn: vi.fn().mockResolvedValue({ id: 'pty-bg' }),
      write: (_ptyId, data) => {
        writes.push(data)
        return true
      },
      kill: () => true,
      getForegroundProcess: async () => null
    })
    const { handle } = await runtime.createTerminal(`path:${TEST_WORKTREE_PATH}`)

    await expect(
      runtime.sendTerminal(handle, { text: 'retry-safe' }, { operationId: 'paste-op-retry' })
    ).resolves.toMatchObject({ handle, accepted: true })
    await expect(
      runtime.sendTerminal(handle, { text: 'retry-safe' }, { operationId: 'paste-op-retry' })
    ).resolves.toMatchObject({ handle, accepted: true })

    expect(writes).toEqual(['retry-safe'])
  })

  it('deduplicates simultaneous first terminal.send attempts with the same operation ID', async () => {
    let releaseWrite!: () => void
    const writeStarted = new Promise<void>((resolve) => {
      releaseWrite = resolve
    })
    let signalWriteStarted!: () => void
    const writeStartedSignal = new Promise<void>((resolve) => {
      signalWriteStarted = resolve
    })
    const writes: string[] = []
    const runtime = new OrcaRuntimeService(store)
    runtime.setPtyController({
      spawn: vi.fn().mockResolvedValue({ id: 'pty-bg' }),
      write: (_ptyId, data) => {
        writes.push(data)
        return true
      },
      kill: () => true,
      getForegroundProcess: async () => null
    })
    const { handle } = await runtime.createTerminal(`path:${TEST_WORKTREE_PATH}`)

    const first = runtime.sendTerminal(
      handle,
      { text: 'concurrent' },
      {
        operationId: 'paste-op-concurrent',
        beforeWrite: async () => {
          signalWriteStarted()
          await writeStarted
        }
      }
    )
    await writeStartedSignal

    const second = runtime.sendTerminal(
      handle,
      { text: 'concurrent' },
      { operationId: 'paste-op-concurrent' }
    )
    const conflicting = runtime.sendTerminal(
      handle,
      { text: 'different' },
      { operationId: 'paste-op-concurrent' }
    )

    await expect(conflicting).rejects.toThrow('terminal_send_operation_conflict')
    expect(writes).toEqual([])

    releaseWrite()
    await expect(first).resolves.toMatchObject({ handle, accepted: true })
    await expect(second).resolves.toMatchObject({ handle, accepted: true })
    expect(writes).toEqual(['concurrent'])
  })

  it('rejects a reused terminal.send operation ID with different bytes', async () => {
    const runtime = new OrcaRuntimeService(store)
    runtime.setPtyController({
      spawn: vi.fn().mockResolvedValue({ id: 'pty-bg' }),
      write: vi.fn(() => true),
      kill: () => true,
      getForegroundProcess: async () => null
    })
    const { handle } = await runtime.createTerminal(`path:${TEST_WORKTREE_PATH}`)

    await runtime.sendTerminal(handle, { text: 'first' }, { operationId: 'paste-op-conflict' })
    await expect(
      runtime.sendTerminal(handle, { text: 'different' }, { operationId: 'paste-op-conflict' })
    ).rejects.toThrow('terminal_send_operation_conflict')
  })
})
import { acknowledgeAgentPromptSubmit } from './orca-runtime-test-mocks.spec'
