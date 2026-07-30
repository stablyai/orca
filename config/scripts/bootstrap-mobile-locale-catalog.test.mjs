import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  parseTranslationPayload,
  repairMobileTranslatedValue,
  shouldReuseDesktopTranslation,
  translateText
} from './bootstrap-mobile-locale-catalog.mjs'

describe('parseTranslationPayload', () => {
  it('joins valid translation segments', () => {
    expect(
      parseTranslationPayload([
        [
          ['Hello', 'Hola'],
          [' world', ' mundo']
        ]
      ])
    ).toBe('Hello world')
  })

  it('rejects a missing payload[0]', () => {
    expect(() => parseTranslationPayload([])).toThrow('non-empty segment array at payload[0]')
  })

  it('rejects segments without a string first item', () => {
    expect(() => parseTranslationPayload([[['Hello'], [42, 'invalid']]])).toThrow(
      'segment 1 must have a string first item'
    )
  })
})

describe('translateText', () => {
  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  it('clears each attempt timeout before waiting to retry', async () => {
    vi.useFakeTimers()
    const signals = []
    const fetchMock = vi
      .fn()
      .mockImplementationOnce((_url, options) => {
        signals.push(options.signal)
        return Promise.reject(new Error('network failed'))
      })
      .mockImplementationOnce((_url, options) => {
        signals.push(options.signal)
        return Promise.resolve({ ok: true, json: async () => [[['Retried']]] })
      })
    vi.stubGlobal('fetch', fetchMock)

    const result = translateText('Translate me', 'zh-CN')
    await vi.advanceTimersByTimeAsync(0)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(vi.getTimerCount()).toBe(1)

    await vi.advanceTimersByTimeAsync(499)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1)

    await expect(result).resolves.toBe('Retried')
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(signals[1]).not.toBe(signals[0])
    expect(vi.getTimerCount()).toBe(0)
  })

  it('aborts a hung request after ten seconds and retries with a fresh signal', async () => {
    vi.useFakeTimers()
    const signals = []
    const fetchMock = vi
      .fn()
      .mockImplementationOnce((_url, options) => {
        signals.push(options.signal)
        return new Promise((_resolve, reject) => {
          options.signal.addEventListener('abort', () => reject(new Error('request aborted')))
        })
      })
      .mockImplementationOnce((_url, options) => {
        signals.push(options.signal)
        return Promise.resolve({ ok: true, json: async () => [[['Translated']]] })
      })
    vi.stubGlobal('fetch', fetchMock)

    const result = translateText('Translate me', 'zh-CN')
    await vi.advanceTimersByTimeAsync(9_999)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(signals[0].aborted).toBe(false)

    await vi.advanceTimersByTimeAsync(1)
    expect(signals[0].aborted).toBe(true)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(vi.getTimerCount()).toBe(1)

    await vi.advanceTimersByTimeAsync(500)
    await expect(result).resolves.toBe('Translated')
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(signals[1]).not.toBe(signals[0])
    expect(signals[1].aborted).toBe(false)
    expect(vi.getTimerCount()).toBe(0)
  })
})

describe('bootstrap-mobile-locale-catalog', () => {
  it('does not seed untranslated desktop actions as translations', () => {
    expect(shouldReuseDesktopTranslation('Stop', 'Stop')).toBe(false)
    expect(shouldReuseDesktopTranslation('Connecting…', 'Connecting…')).toBe(false)
    expect(shouldReuseDesktopTranslation('Codex', 'Codex')).toBe(true)
  })

  it('uses contextual overrides without translating the Continue agent name', () => {
    expect(
      repairMobileTranslatedValue({
        key: 'm.Scz67W0',
        enValue: 'Continue',
        localeValue: 'Continue',
        locale: 'es'
      })
    ).toBe('Continuar')
    expect(
      repairMobileTranslatedValue({
        key: 'm.dSfrwic',
        enValue: 'Continue',
        localeValue: 'Continuar',
        locale: 'es'
      })
    ).toBe('Continue')
    expect(
      repairMobileTranslatedValue({
        key: 'm.EiCMRDA',
        enValue: 'Unstaged',
        localeValue: 'sin escena',
        locale: 'es'
      })
    ).toBe('Sin preparar')
  })
})
