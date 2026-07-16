import fs from 'node:fs'

import { describe, expect, it } from 'vitest'

import { ZH_HUMAN_KEY_OVERRIDES } from './locale-zh-human-key-overrides.mjs'
import { repairTranslatedValue } from './locale-translation-policy.mjs'

const enCatalog = JSON.parse(
  fs.readFileSync(new URL('../../src/renderer/src/i18n/locales/en.json', import.meta.url), 'utf8')
)
const zhCatalog = JSON.parse(
  fs.readFileSync(new URL('../../src/renderer/src/i18n/locales/zh.json', import.meta.url), 'utf8')
)

function getCatalogValue(key) {
  return key.split('.').reduce((value, part) => value?.[part], enCatalog)
}

function interpolationVariables(value) {
  return [...value.matchAll(/{{\s*([^},\s]+)[^}]*}}/g)].map((match) => match[1]).sort()
}

function flattenStrings(value, prefix = '', entries = new Map()) {
  if (typeof value === 'string') {
    entries.set(prefix, value)
  } else if (value && typeof value === 'object' && !Array.isArray(value)) {
    for (const [key, child] of Object.entries(value)) {
      flattenStrings(child, prefix ? `${prefix}.${key}` : key, entries)
    }
  }
  return entries
}

function isTechnicalEnglishLiteral(key, value) {
  return (
    key.startsWith('auto.lib.agent.catalog.') ||
    key.startsWith('auto.lib.open.in.app.catalog.') ||
    value === 'Español' ||
    /^(?:https?:\/\/|orca:\/\/|\/|~\/|git@|# )/.test(value) ||
    ['.', '_', '@', '['].some((prefix) => value.startsWith(prefix)) ||
    /^(?:git|orca|pnpm|npm|gh|glab)\s/.test(value) ||
    /^[A-Z][A-Z0-9_]+$/.test(value) ||
    (!value.includes(' ') && value.includes('/')) ||
    value.includes('&nbsp;') ||
    (value.includes('>') && /^[.#a-z]/.test(value)) ||
    (value.length > 80 && /[{};]/.test(value))
  )
}

describe('human-reviewed Simplified Chinese policy', () => {
  it('keeps human full-key copy authoritative', () => {
    expect(
      repairTranslatedValue({
        key: 'auto.components.stats.StatsPane.1c96f433e2',
        enValue: 'Time agents worked',
        localeValue: '代理工作时间',
        locale: 'zh'
      })
    ).toBe('智能体工作时长')
    expect(
      repairTranslatedValue({
        key: 'auto.components.right.sidebar.SourceControl.37a81f29ad',
        enValue: 'Generating commit message. Click to stop.',
        localeValue: '生成 commit 消息。单击停止。',
        locale: 'zh'
      })
    ).toBe('正在生成提交信息。点击可停止。')
  })

  it('translates generic development concepts while preserving product catalogs', () => {
    const repair = (key, enValue, localeValue) =>
      repairTranslatedValue({ key, enValue, localeValue, locale: 'zh' })

    expect(repair('auto.components.example.agent', 'Agent', '代理')).toBe('智能体')
    expect(repair('auto.components.example.terminal', 'Terminal', '终端')).toBe('终端')
    expect(repair('auto.components.example.commit', 'Commit', '提交')).toBe('提交')
    expect(repair('auto.components.example.repo', 'Repo', '仓库')).toBe('仓库')
    expect(repair('auto.lib.agent.catalog.example', 'Agent', '代理')).toBe('Agent')
  })

  it('keeps operating-system agents distinct from AI agents', () => {
    const repair = (enValue) =>
      repairTranslatedValue({
        key: 'auto.components.example',
        enValue,
        localeValue: '代理',
        locale: 'zh'
      })

    expect(repair('AI agent')).toBe('智能体')
    expect(repair('SSH agent')).toBe('代理')
    expect(repair('User agent')).toBe('代理')
  })

  it('normalizes manually approved terminology and technical names', () => {
    const repair = (enValue, localeValue) =>
      repairTranslatedValue({ key: 'auto.components.example', enValue, localeValue, locale: 'zh' })

    expect(repair('Repository settings', '存储库设置')).toBe('仓库设置')
    expect(repair('Sparse checkout', '稀疏结账')).toBe('稀疏检出')
    expect(repair('Hosted review', '托管评论')).toBe('托管评审')
    expect(repair('Browser tabs', '浏览器选项卡')).toBe('浏览器标签页')
    expect(repair('Import cookies', '导入 cookie')).toBe('导入 Cookie')
    expect(repair('Connect your account', '连接您的账户')).toBe('连接你的账户')
    expect(repair('You can retry', '您可以重试')).toBe('你可以重试')
    expect(repair('OpenAI', '开放伊')).toBe('OpenAI')
    expect(repair('Hermes automation', '爱马仕自动化')).toBe('Hermes 自动化')
  })

  it('keeps every human key valid and preserves interpolation variables', () => {
    for (const [key, override] of Object.entries(ZH_HUMAN_KEY_OVERRIDES)) {
      const source = getCatalogValue(key)
      expect(source, key).toEqual(expect.any(String))
      expect(override.zh, key).toEqual(expect.any(String))
      expect(interpolationVariables(override.zh), key).toEqual(interpolationVariables(source))
    }
  })

  it('does not leave ordinary English prose in the repaired Chinese catalog', () => {
    const englishEntries = flattenStrings(enCatalog)
    const chineseEntries = flattenStrings(zhCatalog)
    const untranslated = []

    for (const [key, enValue] of englishEntries) {
      const repaired = repairTranslatedValue({
        key,
        enValue,
        localeValue: chineseEntries.get(key),
        locale: 'zh'
      })
      const wordCount = enValue.match(/[A-Za-z][A-Za-z'-]*/g)?.length ?? 0
      if (repaired === enValue && wordCount >= 4 && !isTechnicalEnglishLiteral(key, enValue)) {
        untranslated.push(`${key}: ${enValue}`)
      }
    }

    expect(untranslated).toEqual([])
  })
})
