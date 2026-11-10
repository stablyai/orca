import { describe, expect, it } from 'vitest'
import { parseWslClaudePluginMetadataOutput } from './claude-plugin-skill-sources-wsl'

function record(...fields: string[]): string {
  return `${fields.join('\0')}\0`
}

describe('WSL Claude plugin metadata', () => {
  it('rejects malformed metadata responses', () => {
    expect(() => parseWslClaudePluginMetadataOutput(record('F', '4', '1', ''), 1)).toThrow(
      'invalid response'
    )
  })
})
