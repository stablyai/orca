import { describe, expect, it, vi } from 'vitest'
import type { MobileNativeChatSessionOptionsController } from './use-mobile-native-chat-session-options'
import { dispatchMobileStructuredComposerCommand } from './mobile-structured-composer-command'

function controller(): MobileNativeChatSessionOptionsController {
  return {
    snapshot: [
      {
        id: 'model',
        label: 'Model',
        category: 'model',
        kind: {
          type: 'select',
          currentValue: 'gpt-live',
          choices: [
            { value: 'gpt-live', label: 'GPT Live' },
            { value: 'gpt-next', label: 'GPT Next' }
          ]
        },
        valueSource: 'reported',
        settable: true
      },
      {
        id: 'effort',
        label: 'Reasoning effort',
        kind: {
          type: 'select',
          currentValue: 'medium',
          choices: [
            { value: 'medium', label: 'Medium' },
            { value: 'high', label: 'High' }
          ]
        },
        valueSource: 'reported',
        settable: true
      }
    ],
    pendingId: null,
    setOption: vi.fn(async () => true),
    invokeAction: vi.fn(async () => true),
    recordCommand: vi.fn()
  }
}

describe('structured composer slash dispatch', () => {
  it('opens live model and effort pickers instead of sending command text', async () => {
    const options = controller()

    expect(await dispatchMobileStructuredComposerCommand('/model', options, 'codex')).toEqual({
      handled: true,
      accepted: true,
      error: null
    })
    expect(await dispatchMobileStructuredComposerCommand('/effort', options, 'codex')).toEqual({
      handled: true,
      accepted: true,
      error: null
    })
    expect(options.invokeAction).toHaveBeenNthCalledWith(1, 'model')
    expect(options.invokeAction).toHaveBeenNthCalledWith(2, 'effort')
  })

  it('applies command arguments through structured setOption', async () => {
    const options = controller()

    await dispatchMobileStructuredComposerCommand('/model GPT Next', options, 'codex')
    await dispatchMobileStructuredComposerCommand('/effort high', options, 'claude')

    expect(options.setOption).toHaveBeenNthCalledWith(1, 'model', 'gpt-next')
    expect(options.setOption).toHaveBeenNthCalledWith(2, 'effort', 'high')
  })

  it('visibly refuses every other advertised Codex command', async () => {
    const result = await dispatchMobileStructuredComposerCommand('/review', controller(), 'codex')
    expect(result).toEqual({
      handled: true,
      accepted: true,
      error: '/review is not available in chat sessions.'
    })
  })

  it('leaves unadvertised slash text available as an ordinary prompt', async () => {
    await expect(
      dispatchMobileStructuredComposerCommand('/not-a-catalog-command', controller(), 'claude')
    ).resolves.toEqual({ handled: false, accepted: false, error: null })
  })
})
