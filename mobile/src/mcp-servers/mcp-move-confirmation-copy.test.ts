// The phone's Move confirmation says what Move does: a new or existing host entry, removal tried for
// eligible copies, and a backup of each settings file before an entry leaves it.
import { readFileSync } from 'node:fs'
import i18next from 'i18next'
import { describe, expect, it } from 'vitest'
import enRuntimeRequired from '../i18n/en-runtime-required.json'
import en from '../i18n/locales/en.json'
import { translate } from '../i18n/mobile-i18n'

const KEY = 'mcpServers.moveMessage'
const TEXT =
  "Orca uses a new or existing entry on this host's MCP server list. It tries to remove eligible copies from the settings for {{agents}}. Before removing entries from a settings file, Orca backs up that file."

const actions = readFileSync(new URL('use-mcp-server-actions.ts', import.meta.url), 'utf8')

/** The string literal passed right after the key in its t() call, evaluated as TypeScript would. */
function callerDefault(): string {
  const match = /'mcpServers\.moveMessage',\s*("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*')/.exec(actions)
  expect(match).not.toBeNull()
  const literal = match![1]!
  return literal.startsWith('"')
    ? (JSON.parse(literal) as string)
    : (JSON.parse(
        `"${literal.slice(1, -1).replaceAll("\\'", "'").replaceAll('"', '\\"')}"`
      ) as string)
}

describe('phone Move confirmation copy', () => {
  it('caller default and en.json carry the reviewed text', () => {
    expect(callerDefault()).toBe(TEXT)
    expect((en as { mcpServers: Record<string, unknown> }).mcpServers.moveMessage).toBe(TEXT)
    expect(Buffer.byteLength(TEXT, 'utf8')).toBe(205)
    expect(TEXT.match(/\{\{[^}]+\}\}/g)).toEqual(['{{agents}}'])
    expect(TEXT).not.toContain('’')
  })

  it('English shows the caller default, with the agents filled in', async () => {
    // Not in the boot bundle, so English resolves the call site's default (the missing-resource path).
    expect(
      (enRuntimeRequired as { mcpServers?: Record<string, unknown> }).mcpServers?.moveMessage
    ).toBeUndefined()
    const agents = 'Claude Code, Codex, and Cursor'
    const expected = TEXT.replace('{{agents}}', agents)
    expect(translate(KEY, callerDefault(), { agents })).toBe(expected)
    // A build that serves en.json as the English resource shows the same words.
    const withCatalog = i18next.createInstance()
    await withCatalog.init({
      lng: 'en',
      resources: { en: { translation: en } },
      interpolation: { escapeValue: false }
    })
    expect(withCatalog.t(KEY, { defaultValue: 'unused fallback', agents })).toBe(expected)
  })
})
