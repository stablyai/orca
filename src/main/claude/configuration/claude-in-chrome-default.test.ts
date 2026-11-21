import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { claudeInChromeDefaultArgs } from './claude-in-chrome-default'

let configDir: string

beforeEach(() => {
  configDir = mkdtempSync(join(tmpdir(), 'orca-claude-chrome-'))
  writeFileSync(
    join(configDir, '.claude.json'),
    JSON.stringify({ claudeInChromeDefaultEnabled: true })
  )
})

afterEach(() => {
  rmSync(configDir, { recursive: true, force: true })
})

it('applies Claude in Chrome "Enabled by default" unless the launch already chooses', async () => {
  const env = { CLAUDE_CONFIG_DIR: configDir }
  await expect(claudeInChromeDefaultArgs(env, [], 'darwin')).resolves.toEqual({ chrome: null })
  await expect(claudeInChromeDefaultArgs(env, ['--no-chrome'], 'darwin')).resolves.toEqual({})
  await expect(
    claudeInChromeDefaultArgs({ ...env, CLAUDE_CODE_ENABLE_CFC: '0' }, [], 'darwin')
  ).resolves.toEqual({})
})
