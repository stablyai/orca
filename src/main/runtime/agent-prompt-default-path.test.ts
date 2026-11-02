/** Default writes preserve queue and per-send PTY lookup; only opted-in sends use submission settlement. */

import { describe, expect, it, vi } from 'vitest'
import { OrcaRuntimeService } from './orca-runtime'
import { settledWriteStub } from '../providers/settled-pty-write-stub'

const PTY = 'pty-default-path'
const HANDLE = 'term_default_path'

function dispatchRuntime(): OrcaRuntimeService {
  const runtime = new OrcaRuntimeService()
  const write = vi.fn(() => true)
  runtime.setPtyController({
    write,
    writeWithSettlement: settledWriteStub(write),
    kill: () => true,
    getForegroundProcess: async () => null
  })
  runtime.registerPty(PTY, 'repo::/tmp/default-path', null, {
    tabId: '11111111-1111-4111-8111-111111111111',
    leafId: '22222222-2222-4222-8222-222222222222',
    incarnationId: 'default-path-test'
  })
  runtime.registerPreAllocatedHandleForPty(PTY, HANDLE)
  return runtime
}

describe('agent prompt writer: default path', () => {
  it('never enters the opt-in submit layer', async () => {
    const target = dispatchRuntime()
    const submit = vi.fn()
    Object.defineProperty(target, 'submitTerminalAgentPrompt', { value: submit })
    Object.defineProperty(target, 'writeTerminalAgentPrompt', {
      value: async () => ({ submits: 1 })
    })

    await expect(
      target.sendTerminalAgentPrompt(HANDLE, 'hello', { inputKind: 'driving' })
    ).resolves.toMatchObject({ accepted: true })
    expect(submit).not.toHaveBeenCalled()
  })

  it('writes a queued leaf prompt to the PTY the leaf names when its turn comes', async () => {
    const target = dispatchRuntime()
    const leaf = { writable: true, ptyId: PTY }
    const written: string[] = []
    let releaseFirst!: () => void
    const firstHeld = new Promise<void>((resolve) => {
      releaseFirst = resolve
    })
    Object.defineProperties(target, {
      getLivePtyForHandle: { value: () => null },
      getLiveLeafForHandle: { value: () => ({ leaf }) },
      isLeafPtyProvenAbsent: { value: async () => false },
      // Default-path relookup assumes the replacement PTY shares this generation.
      assertAgentPromptGeneration: { value: () => {} },
      writeTerminalAgentPrompt: {
        value: async (_handle: string, ptyId: string) => {
          written.push(ptyId)
          if (written.length === 1) {
            await firstHeld
          }
          return { submits: 1 }
        }
      }
    })

    const first = target.sendTerminalAgentPrompt(HANDLE, 'first', { inputKind: 'driving' })
    while (written.length === 0) {
      await new Promise((resolve) => setTimeout(resolve, 0))
    }
    const second = target.sendTerminalAgentPrompt(HANDLE, 'second', { inputKind: 'driving' })
    await new Promise((resolve) => setTimeout(resolve, 0))
    target.registerPty('pty-default-path-respawned', 'repo::/tmp/default-path', null)
    leaf.ptyId = 'pty-default-path-respawned'
    releaseFirst()

    await first
    await second
    expect(written).toEqual([PTY, 'pty-default-path-respawned'])
  })
})
