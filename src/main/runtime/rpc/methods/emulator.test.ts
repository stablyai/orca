import { describe, expect, it, vi } from 'vitest'
import { EMULATOR_METHODS } from './emulator'

const method = (name: string) => {
  const found = EMULATOR_METHODS.find((candidate) => candidate.name === name)
  if (!found) {
    throw new Error(`Missing ${name}`)
  }
  return found
}

describe('emulator control RPC methods', () => {
  it('accepts optional longPress and routes it without loss', async () => {
    const emulatorButton = vi.fn().mockResolvedValue({ ok: true })
    const button = method('emulator.button')

    const params = button.params?.parse({
      name: 'power',
      longPress: true,
      device: 'emulator-5554',
      worktree: 'wt-1'
    })
    await button.handler(params, { runtime: { emulatorButton } } as never)

    expect(emulatorButton).toHaveBeenCalledWith({
      name: 'power',
      longPress: true,
      device: 'emulator-5554',
      worktree: 'wt-1'
    })
    expect(button.params?.safeParse({ name: 'power', longPress: 'yes' }).success).toBe(false)
  })

  it('accepts only folded and unfolded posture values and routes targets', async () => {
    const emulatorPosture = vi.fn().mockResolvedValue({ ok: true })
    const posture = method('emulator.posture')

    const params = posture.params?.parse({
      posture: 'folded',
      emulator: 'foldable-api-35',
      worktree: 'wt-2'
    })
    await posture.handler(params, { runtime: { emulatorPosture } } as never)

    expect(emulatorPosture).toHaveBeenCalledWith({
      posture: 'folded',
      emulator: 'foldable-api-35',
      worktree: 'wt-2'
    })
    expect(posture.params?.safeParse({ posture: 'half-open' }).success).toBe(false)
  })
})
