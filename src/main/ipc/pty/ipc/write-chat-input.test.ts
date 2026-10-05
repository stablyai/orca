import { describe, expect, it, vi } from 'vitest'
import { createPtyWriteInput } from './write-input'
import type { OrcaRuntimeService } from '../../../runtime/orca-runtime'

function makeRuntime(driver: 'mobile' | 'desktop' = 'desktop') {
  const writeNativeChatInputToPty = vi.fn(async () => ({ accepted: true, bytesWritten: 5 }))
  const runtime = {
    getDriver: vi.fn(() => ({ kind: driver })),
    writeNativeChatInputToPty
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: The IPC adapter reads only these two runtime members.
  return { runtime: runtime as unknown as OrcaRuntimeService, writeNativeChatInputToPty }
}

describe('pty:writeChatInput adapter', () => {
  it('hands an SSH-owned chat write to the runtime guard instead of refusing it like writeAccepted', async () => {
    const { runtime, writeNativeChatInputToPty } = makeRuntime()
    const { writePtyChatInput, writePtyInputAccepted } = createPtyWriteInput({ runtime })
    const args = {
      id: 'ssh:conn@@pty-1',
      data: 'hello',
      inputKind: 'driving' as const,
      actionId: 'a1'
    }

    await expect(writePtyChatInput(args)).resolves.toEqual({ accepted: true, bytesWritten: 5 })
    expect(writeNativeChatInputToPty).toHaveBeenCalledWith(
      'ssh:conn@@pty-1',
      'hello',
      'driving',
      'a1',
      expect.any(Function)
    )
    // The fire-and-forget ack this replaces refuses every non-local PTY.
    expect(await writePtyInputAccepted(args)).toBe(false)
  })

  it('refuses while a phone holds the input floor, without writing', async () => {
    const { runtime, writeNativeChatInputToPty } = makeRuntime('mobile')
    const { writePtyChatInput } = createPtyWriteInput({ runtime })
    await expect(
      writePtyChatInput({ id: 'pty-1', data: 'x', inputKind: 'driving', actionId: 'a1' })
    ).resolves.toEqual({ accepted: false, bytesWritten: 0 })
    expect(writeNativeChatInputToPty).not.toHaveBeenCalled()
  })

  it('reports a thrown runtime write as delivery-unknown, never as refused', async () => {
    const { runtime, writeNativeChatInputToPty } = makeRuntime()
    writeNativeChatInputToPty.mockRejectedValueOnce(new Error('boom'))
    const { writePtyChatInput } = createPtyWriteInput({ runtime })
    await expect(
      writePtyChatInput({ id: 'pty-1', data: 'x', inputKind: 'driving', actionId: 'a1' })
    ).resolves.toEqual({ accepted: false, bytesWritten: 0, deliveryUnknown: true })
  })

  it('validates the action id on the payload', () => {
    const { isPtyChatInputPayload } = createPtyWriteInput({ runtime: makeRuntime().runtime })
    const base = { id: 'pty-1', data: 'x', inputKind: 'driving' }
    expect(isPtyChatInputPayload({ ...base, actionId: 'a1' })).toBe(true)
    expect(isPtyChatInputPayload(base)).toBe(false)
    expect(isPtyChatInputPayload({ ...base, actionId: '' })).toBe(false)
    expect(isPtyChatInputPayload({ ...base, actionId: 'x'.repeat(129) })).toBe(false)
  })
})
