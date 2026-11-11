import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { withoutRejectedClaudeApiKey } from './claude-rejected-api-key'

it('honors profile approval ahead of a shared rejection, while dropping rejected-only keys', async () => {
  const home = mkdtempSync(join(tmpdir(), 'claude-api-key-'))
  const config = join(home, 'claude')
  mkdirSync(config)
  const env = {
    HOME: home,
    CLAUDE_CONFIG_DIR: config,
    ANTHROPIC_API_KEY: 'fixture-prefix-0123456789abcdefghij'
  }
  try {
    writeFileSync(
      join(config, '.claude.json'),
      JSON.stringify({
        customApiKeyResponses: {
          approved: ['0123456789abcdefghij'],
          rejected: ['0123456789abcdefghij']
        }
      })
    )
    expect(await withoutRejectedClaudeApiKey({ ...env })).toEqual(env)
    writeFileSync(
      join(config, '.claude.json'),
      JSON.stringify({
        customApiKeyResponses: { approved: [], rejected: ['0123456789abcdefghij'] }
      })
    )
    expect(await withoutRejectedClaudeApiKey({ ...env })).toEqual({
      HOME: home,
      CLAUDE_CONFIG_DIR: config
    })
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})
