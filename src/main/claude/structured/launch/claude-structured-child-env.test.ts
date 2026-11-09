import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { runProcess } from '@orca/process-host'
import {
  claudeChildEnv,
  resolveClaudeChildEnvSources,
  withOrcaClaudeEntrypoint
} from './claude-structured-child-env'
import { resolveStructuredAgentCommand } from '../../../native-chat/structured-agent-command-resolution'

afterEach(() => {
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
})

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

it('keeps a differently cased Windows launch value over the Orca default', () => {
  const inherited = { Claude_Code_Entrypoint: 'cli', PATH: 'C:\\bin' }
  expect(
    withOrcaClaudeEntrypoint(inherited, { claude_code_entrypoint: 'company-client' }, 'win32')
  ).toEqual({ PATH: 'C:\\bin', CLAUDE_CODE_ENTRYPOINT: 'company-client' })
  expect(withOrcaClaudeEntrypoint(inherited, undefined, 'win32')).toEqual({
    PATH: 'C:\\bin',
    CLAUDE_CODE_ENTRYPOINT: 'orca'
  })
  expect(
    withOrcaClaudeEntrypoint(
      inherited,
      {
        CLAUDE_CODE_ENTRYPOINT: 'first',
        claude_code_entrypoint: 'last'
      },
      'win32'
    )
  ).toEqual({ PATH: 'C:\\bin', CLAUDE_CODE_ENTRYPOINT: 'last' })
})

it('uses configured Windows values for both Claude lookup and its final child', async () => {
  vi.stubGlobal('process', { ...process, platform: 'win32' })
  const sources = await resolveClaudeChildEnvSources({
    resolveInheritedEnv: async () => ({
      PATH: '/inherited/bin',
      TOKEN: 'inherited',
      CLAUDE_CONFIG_DIR: '/ambient'
    }),
    resolveEnv: () => ({
      path: '/configured/bin',
      tOKEN: 'configured',
      claude_config_dir: '/configured/home'
    }),
    resolveCommand: (options) => {
      expect(options?.pathEnv).toBe('/configured/bin')
      return { command: '/configured/bin/claude.exe', prefixArgs: [] }
    }
  })
  expect(claudeChildEnv(sources, undefined, { runtimeOnPath: false })).toEqual({
    PATH: '/configured/bin',
    TOKEN: 'configured',
    CLAUDE_CONFIG_DIR: '/configured/home',
    CLAUDE_CODE_ENTRYPOINT: 'orca'
  })
})

it.skipIf(process.platform !== 'win32')(
  'passes configured values through a real Windows child despite inherited casing',
  async () => {
    vi.stubEnv('ORCA_NATIVE_ENV_CASE_PROBE', 'inherited')
    const sources = await resolveClaudeChildEnvSources({
      resolveEnv: () => ({ orca_native_env_case_probe: 'configured' }),
      resolveCommand: () => ({ command: process.execPath, prefixArgs: [] })
    })
    const result = await runProcess({
      program: sources.command,
      args: ['--eval', 'process.stdout.write(process.env.ORCA_NATIVE_ENV_CASE_PROBE ?? "")'],
      env: claudeChildEnv(sources, undefined, { runtimeOnPath: false }),
      timeoutMs: 30_000
    })
    expect(result.code).toBe(0)
    expect(result.stdout).toBe('configured')
  }
)
