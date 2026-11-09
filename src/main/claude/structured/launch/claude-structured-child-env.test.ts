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

it('isolates inherited Claude stamps before applying launch settings', () => {
  const sources = {
    command: 'claude',
    prefixArgs: [],
    overlay: undefined,
    inheritedEnv: {
      CLAUDE_CODE_ENTRYPOINT: 'cli',
      CLAUDECODE: '1',
      CLAUDE_CODE_MESSAGING_SOCKET: 'parent-socket',
      CLAUDE_AGENT_SDK_VERSION: 'parent-sdk',
      CLAUDE_EFFORT: 'parent-effort',
      CLAUDE_CODE_HTTP_PROXY: 'http://user-proxy'
    }
  }
  const options = { runtimeOnPath: false }
  expect(claudeChildEnv(sources, undefined, options)).toEqual({
    CLAUDE_CODE_ENTRYPOINT: 'orca',
    CLAUDE_CODE_HTTP_PROXY: 'http://user-proxy'
  })
  const overlay = { CLAUDE_CODE_ENTRYPOINT: 'custom', CLAUDE_EFFORT: 'configured-effort' }
  expect(claudeChildEnv({ ...sources, overlay }, undefined, options)).toEqual({
    ...overlay,
    CLAUDE_CODE_HTTP_PROXY: 'http://user-proxy'
  })
})

it('keeps a differently cased Windows launch value over the Orca default', () => {
  const inherited = {
    Claude_Code_Entrypoint: 'cli',
    CLAUDE_CODE_MESSAGING_TOKEN: 'parent-token',
    Claude_Agent_Sdk_Version: 'parent-sdk',
    PATH: 'C:\\bin'
  }
  expect(
    withOrcaClaudeEntrypoint(
      inherited,
      { claude_code_entrypoint: 'company-client', claude_agent_sdk_version: 'configured-sdk' },
      'win32'
    )
  ).toEqual({
    PATH: 'C:\\bin',
    CLAUDE_CODE_ENTRYPOINT: 'company-client',
    CLAUDE_AGENT_SDK_VERSION: 'configured-sdk'
  })
  expect(withOrcaClaudeEntrypoint(inherited, undefined, 'win32')).toEqual({
    PATH: 'C:\\bin',
    CLAUDE_CODE_ENTRYPOINT: 'orca'
  })
})
