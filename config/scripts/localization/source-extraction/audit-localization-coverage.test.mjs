import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { collectLocalizationCandidates, findNewCandidates } from './audit-localization-coverage.mjs'

const root = process.cwd()
const scan = (file, source, options = {}) =>
  collectLocalizationCandidates(path.join(root, file), source, root, options).map(
    ({ kind, text }) => `${kind}: ${text}`
  )

describe('localization coverage audit', () => {
  it('flags catalog data the English catalog has no key for', () => {
    const source =
      "export const BOT_MCP_APPS = [{ id: 'x', name: 'X', line: 'Read the new things' }]"
    expect(scan('src/shared/bots/bot-mcp-apps.ts', source, { catalogEnglish: new Set() })).toEqual([
      'catalog-data:line: Read the new things'
    ])
    expect(
      scan('src/shared/bots/bot-mcp-apps.ts', source, {
        catalogEnglish: new Set(['Read the new things'])
      })
    ).toEqual([])
  })

  it('passes the shipped app catalogs against the shipped English catalog', () => {
    const english = new Set()
    const walk = (node) =>
      typeof node === 'string' ? english.add(node) : Object.values(node).forEach(walk)
    walk(JSON.parse(readFileSync('src/renderer/src/i18n/locales/en.json', 'utf8')))
    for (const file of [
      'src/shared/bots/bot-mcp-apps.ts',
      'src/shared/composio/composio-curated-apps.ts'
    ]) {
      const hits = scan(file, readFileSync(file, 'utf8'), { catalogEnglish: english })
      expect(hits.filter((hit) => hit.startsWith('catalog-data:'))).toEqual([])
    }
  })

  it('flags a prose error message thrown in bots UI code, not codes or translated text', () => {
    const source = [
      "throw new Error('Reading more items failed')",
      "throw new Error(ok ? 'bot_avatar_invalid' : 'The upload went wrong')",
      "throw new Error('bot_avatar_type')",
      "throw new Error(translate('bots.x', 'Already translated text'))"
    ].join('\n')
    expect(scan('src/renderer/src/components/bots/x.ts', source)).toEqual([
      'error-message: Reading more items failed',
      'error-message: The upload went wrong'
    ])
    expect(scan('mobile/src/bots/x.ts', source)).toHaveLength(2)
    expect(scan('src/renderer/src/components/terminal/x.ts', source)).toEqual([])
  })

  it('lets a path-only allowlist entry cover a whole agent-facing file', () => {
    const reports = [
      {
        filePath: 'src/shared/bots/agent.ts',
        kind: 'object-property:message',
        text: 'A',
        dynamic: false
      },
      {
        filePath: 'src/shared/bots/ui.ts',
        kind: 'object-property:message',
        text: 'B',
        dynamic: false
      }
    ]
    expect(
      findNewCandidates(reports, [{ filePath: 'src/shared/bots/agent.ts', reason: 'agent text' }])
    ).toEqual([reports[1]])
  })
})
