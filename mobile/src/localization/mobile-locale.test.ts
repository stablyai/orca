import { describe, expect, it } from 'vitest'
import { parseMobileLocale, translateMobileCopy } from './mobile-locale'
import { english } from './catalogs/en'
import { simplifiedChinese } from './catalogs/zh-CN'

describe('mobile locale', () => {
  it('accepts only supported persisted locales', () => {
    expect(parseMobileLocale('en')).toBe('en')
    expect(parseMobileLocale('zh-CN')).toBe('zh-CN')
    expect(parseMobileLocale('zh')).toBeNull()
    expect(parseMobileLocale(null)).toBeNull()
  })

  it('translates copy and interpolates values', () => {
    expect(translateMobileCopy('zh-CN', 'home.removeHostMessage', { name: 'Desk' })).toBe(
      '移除“Desk”？之后仍可重新配对。'
    )
    expect(translateMobileCopy('en', 'pair.timeout', { seconds: 25 })).toBe(
      "Couldn't connect within 25s — see log below for where it stalled"
    )
  })

  it('translates the native chat controls and recovery states', () => {
    expect(translateMobileCopy('zh-CN', 'chat.tools')).toBe('工具')
    expect(translateMobileCopy('zh-CN', 'chat.stop')).toBe('停止')
    expect(translateMobileCopy('zh-CN', 'chat.messageNotSentReconnecting')).toBe(
      '消息未发送，正在重新连接…'
    )
    expect(translateMobileCopy('zh-CN', 'chat.waitingForTerminal')).toBe('正在等待终端…')
  })

  it('translates the manual pairing-code flow', () => {
    expect(translateMobileCopy('zh-CN', 'pair.invalidCode')).toBe(
      '不是有效的配对码，请从电脑端复制后重新粘贴'
    )
    expect(translateMobileCopy('zh-CN', 'pair.pasteTitle')).toBe('粘贴配对码')
    expect(translateMobileCopy('zh-CN', 'pair.pastePlaceholder')).toBe(
      'orca://pair?code=... 或粘贴配对码'
    )
  })

  it('keeps interpolation placeholders aligned across catalogs', () => {
    const placeholderPattern = /\{([^}]+)\}/g
    for (const key of Object.keys(english) as Array<keyof typeof english>) {
      const englishPlaceholders = [...english[key].matchAll(placeholderPattern)].map(
        ([, name]) => name
      )
      const chinesePlaceholders = [...simplifiedChinese[key].matchAll(placeholderPattern)].map(
        ([, name]) => name
      )
      expect(chinesePlaceholders, key).toEqual(englishPlaceholders)
    }
  })
})
