import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  isInteractiveZcodeVersionOutput,
  markInteractiveZcodeUnavailable,
  resetInteractiveZcodeAvailabilityForTests,
  resolveZcodePromptDelivery
} from './interactive-client'

describe('ZCode interactive client detection', () => {
  afterEach(() => resetInteractiveZcodeAvailabilityForTests())
  it('recognizes the third-party TUI distribution marker', () => {
    expect(isInteractiveZcodeVersionOutput('zcode-app-cli 3.7.5-11\nzcode-runtime 0.16.1\n')).toBe(
      true
    )
  })

  it('does not treat the official headless runtime as an interactive client', () => {
    expect(isInteractiveZcodeVersionOutput('zcode 0.16.1\n')).toBe(false)
  })

  it('fails closed for empty or unrelated version output', () => {
    expect(isInteractiveZcodeVersionOutput('')).toBe(false)
    expect(isInteractiveZcodeVersionOutput('some-zcode-wrapper 1.0.0')).toBe(false)
  })

  it('uses the local interactive client when its capability probe succeeds', async () => {
    const probe = vi.fn(async () => true)
    await expect(
      resolveZcodePromptDelivery({
        isRemote: false,
        probeInteractiveClient: probe
      })
    ).resolves.toBe('agent-input')
    expect(probe).toHaveBeenCalledOnce()

    await expect(
      resolveZcodePromptDelivery({
        isRemote: false,
        probeInteractiveClient: async () => false
      })
    ).resolves.toBe('startup-command')
  })

  it('temporarily falls back after a proven interactive readiness failure', async () => {
    markInteractiveZcodeUnavailable(100)
    const probe = vi.fn(async () => true)
    const now = vi.spyOn(Date, 'now').mockReturnValue(101)
    await expect(
      resolveZcodePromptDelivery({ isRemote: false, probeInteractiveClient: probe })
    ).resolves.toBe('startup-command')
    expect(probe).not.toHaveBeenCalled()
    now.mockRestore()
  })

  it('keeps remote and command-override launches on the atomic one-shot path', async () => {
    const probe = async (): Promise<boolean> => {
      throw new Error('probe should not run')
    }
    await expect(
      resolveZcodePromptDelivery({ isRemote: true, probeInteractiveClient: probe })
    ).resolves.toBe('startup-command')
    await expect(
      resolveZcodePromptDelivery({
        isRemote: false,
        commandOverride: 'custom-zcode',
        probeInteractiveClient: probe
      })
    ).resolves.toBe('startup-command')
  })

  it('ignores an empty command override when selecting the local interactive client', async () => {
    await expect(
      resolveZcodePromptDelivery({
        isRemote: false,
        commandOverride: '   ',
        probeInteractiveClient: async () => true
      })
    ).resolves.toBe('agent-input')
  })
})
