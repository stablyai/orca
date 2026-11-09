import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import {
  claudeChildEnv,
  resolveClaudeChildEnvSources,
  withOrcaClaudeEntrypoint
} from './claude-structured-child-env'
import { resolveStructuredAgentCommand } from '../../../native-chat/structured-agent-command-resolution'

afterEach(() => vi.unstubAllEnvs())

it('resolves a custom Claude command against the login shell PATH', async () => {
  const root = mkdtempSync(join(tmpdir(), 'orca-shell-only-cli-'))
  try {
    const binary = join(root, process.platform === 'win32' ? 'claude-custom.cmd' : 'claude-custom')
    writeFileSync(binary, '#!/bin/sh\nexit 0\n')
    chmodSync(binary, 0o755)
    vi.stubEnv('PATH', '')
    const settings = { agentCmdOverrides: { claude: 'claude-custom' } }
    const inherited = vi.fn(async () => ({ PATH: root, HOME: root }))
    const sources = await resolveClaudeChildEnvSources({
      resolveCommand: (options) => resolveStructuredAgentCommand('claude', settings, options),
      resolveEnv: async () => ({}),
      resolveInheritedEnv: inherited
    })
    expect(sources.command).toBe(binary)
    expect(sources.inheritedEnv.PATH).toBe(root)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

it('names Orca as the Claude client unless the launch environment sets one', () => {
  const sources = {
    command: 'claude',
    prefixArgs: [],
    overlay: undefined,
    inheritedEnv: { CLAUDE_CODE_ENTRYPOINT: 'cli' }
  }
  const options = { runtimeOnPath: false }
  expect(claudeChildEnv(sources, undefined, options).CLAUDE_CODE_ENTRYPOINT).toBe('orca')
  const overlay = { CLAUDE_CODE_ENTRYPOINT: 'custom' }
  expect(claudeChildEnv({ ...sources, overlay }, undefined, options).CLAUDE_CODE_ENTRYPOINT).toBe(
    'custom'
  )
})

it('keeps a differently cased Windows launch value over the Orca default', () => {
  const inherited = { Claude_Code_Entrypoint: 'cli', PATH: 'C:\\bin' }
  expect(
    withOrcaClaudeEntrypoint(inherited, { claude_code_entrypoint: 'company-client' }, 'win32')
  ).toEqual({ PATH: 'C:\\bin', CLAUDE_CODE_ENTRYPOINT: 'company-client' })
  expect(withOrcaClaudeEntrypoint(inherited, undefined, 'win32')).toEqual({
    PATH: 'C:\\bin',
    CLAUDE_CODE_ENTRYPOINT: 'orca'
  })
})
