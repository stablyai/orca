import { describe, expect, it } from 'vitest'
import {
  cursorCatalogCredentialScope,
  cursorContextWindowTokens,
  cursorModelSelection,
  cursorModelsToSessionOptions
} from './cursor-model-catalog'
import type { CursorSdkListedModel } from './cursor-sdk-protocol'

const listed: CursorSdkListedModel[] = [
  { id: 'auto', displayName: 'Auto' },
  { id: 'composer-2.5', displayName: 'Composer 2.5' }
]

describe('cursor model catalog', () => {
  it('uses the same default for the picker and a run with no chosen model', () => {
    const options = cursorModelsToSessionOptions(listed)
    const selected = cursorModelSelection({}, listed)
    expect(options.find((model) => model.isDefault)?.id).toBe('composer-2.5')
    expect(selected.id).toBe('composer-2.5')
  })

  it('keeps reasoning effort apart from the context window', () => {
    const model: CursorSdkListedModel = {
      id: 'claude-opus-5-5',
      displayName: 'Claude Opus 5.5',
      parameters: [
        {
          id: 'context',
          values: [
            { value: '300k', displayName: '300K' },
            { value: '1m', displayName: '1M' }
          ]
        },
        {
          id: 'effort',
          values: [
            { value: 'low', displayName: 'Low' },
            { value: 'medium', displayName: 'Medium' }
          ]
        },
        { id: 'thinking', values: [{ value: 'false' }, { value: 'true' }] },
        { id: 'fast', values: [{ value: 'false' }, { value: 'true', displayName: 'Fast' }] }
      ],
      variants: [
        {
          isDefault: true,
          params: [
            { id: 'context', value: '1m' },
            { id: 'effort', value: 'medium' },
            { id: 'fast', value: 'false' }
          ]
        }
      ]
    }
    const [option] = cursorModelsToSessionOptions([model])
    expect(option?.efforts.map((effort) => effort.value)).toEqual(['low', 'medium'])
    expect(option?.defaultEffort).toBe('medium')
    expect(option?.contextWindows?.map((choice) => choice.value)).toEqual(['300k', '1m'])
    expect(option?.defaultContextWindow).toBe('1m')
    expect(option?.thinkingLevels?.map((choice) => choice.label)).toEqual(['Off', 'On'])
    expect(option?.supportsFastMode).toBe(true)
    expect(cursorModelSelection({ model: 'claude-opus-5-5' }, [model])).toEqual({
      id: 'claude-opus-5-5',
      params: [
        { id: 'effort', value: 'medium' },
        { id: 'context', value: '1m' }
      ]
    })
    expect(
      cursorModelSelection(
        { model: 'claude-opus-5-5', effort: 'low', context: '300k', fastMode: 'true' },
        [model]
      )
    ).toEqual({
      id: 'claude-opus-5-5',
      params: [
        { id: 'effort', value: 'low' },
        { id: 'context', value: '300k' },
        { id: 'fast', value: 'true' }
      ]
    })
    expect(cursorContextWindowTokens('1m')).toBe(1_000_000)
    expect(cursorContextWindowTokens('256k')).toBe(256_000)
  })

  it('names a key by its hash', () => {
    expect(cursorCatalogCredentialScope('secret')).not.toContain('secret')
    expect(cursorCatalogCredentialScope(' secret ')).toBe(cursorCatalogCredentialScope('secret'))
    expect(cursorCatalogCredentialScope(undefined)).toBe('browser-login')
    expect(cursorCatalogCredentialScope('other')).not.toBe(cursorCatalogCredentialScope('secret'))
  })
})
