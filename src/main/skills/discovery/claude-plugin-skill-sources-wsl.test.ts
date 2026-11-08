import { describe, expect, it } from 'vitest'
import { parseWslClaudePluginMetadataOutput } from './claude-plugin-skill-sources-wsl'

function record(...fields: string[]): string {
  return `${fields.join('\0')}\0`
}

describe('WSL Claude plugin metadata', () => {
  it('decodes present files and retains missing files as null', () => {
    const settings = JSON.stringify({ enabledPlugins: { 'plugin@market': true } })
    const output = [
      record('F', '0', '1', Buffer.from(settings).toString('base64')),
      record('F', '1', '0', '')
    ].join('')

    expect(parseWslClaudePluginMetadataOutput(output, 2)).toEqual([settings, null])
  })

  it('rejects malformed metadata responses', () => {
    expect(() => parseWslClaudePluginMetadataOutput(record('F', '4', '1', ''), 1)).toThrow(
      'invalid response'
    )
  })
})
