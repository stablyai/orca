import { describe, expect, it } from 'vitest'
import { getContextPressureCopy } from './context-pressure-copy'

describe('getContextPressureCopy', () => {
  it.each([
    ['en-US', 'Context window'],
    ['es-ES', 'Ventana de contexto'],
    ['ja-JP', 'コンテキストウィンドウ'],
    ['ko-KR', '컨텍스트 창'],
    ['zh-CN', '上下文窗口']
  ])('selects copy for %s', (locale, title) => {
    expect(getContextPressureCopy(locale).title).toBe(title)
  })

  it('falls back to English for unsupported locales', () => {
    expect(getContextPressureCopy('fr-FR')).toBe(getContextPressureCopy('en'))
  })

  it('localizes every pressure level and limit source', () => {
    const copy = getContextPressureCopy('es')
    expect(Object.keys(copy.levels)).toEqual(['ok', 'warning', 'critical'])
    expect(Object.keys(copy.limitSources)).toEqual(['soft-cap', 'model', 'provider'])
    expect(copy.levels.critical).not.toBe(getContextPressureCopy('en').levels.critical)
  })
})
