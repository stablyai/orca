import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { prepareWorkInboxCliLaunch, workInboxCliServer } from './work-inbox-cli-launch'
import {
  codexWorkInboxLaunchArgs,
  prepareCodexWorkInboxCommand,
  withCodexWorkInboxCommand
} from '../../codex/codex-work-inbox-launch'
import { codexWorkInboxDeveloperInstructions } from '../../codex/codex-work-inbox-instructions'
import { claudeWorkInboxOptions } from '../../claude/claude-work-inbox-options'
import { tokenizeStartupCommand } from '../../../shared/tui-agent-startup-shell'
const environment = vi.hoisted(() => ({ root: '' }))
vi.mock('../../../shared/app-environment', () => ({
  hasAppEnvironment: () => true,
  getAppEnvironment: () => ({ getPath: () => environment.root, getAppPath: () => environment.root })
}))
beforeEach(async () => {
  environment.root = await mkdtemp(join(tmpdir(), 'inbox-launch-'))
  await mkdir(join(environment.root, 'out', 'cli'), { recursive: true })
  await writeFile(join(environment.root, 'out', 'cli', 'index.js'), '')
})
afterEach(async () => {
  await rm(environment.root, { recursive: true, force: true })
})
describe('inbox launch contracts', () => {
  it.each(['powershell', 'cmd'] as const)(
    'refuses unsafe Codex instruction quoting in %s before probing',
    async (shell) => {
      await expect(
        prepareCodexWorkInboxCommand({ command: 'codex', agent: 'codex', shell, remote: false })
      ).rejects.toThrow('requires a POSIX shell')
    }
  )
  it('preserves the provider-inherited terminal but never ambient native session identity', () => {
    const terminal = workInboxCliServer({ ORCA_WORK_INBOX_ROUTING: '1' })
    expect(Object.hasOwn(terminal.env, 'ORCA_TERMINAL_HANDLE')).toBe(false)
    expect(terminal.env).toMatchObject({ ORCA_AGENT_SESSION_ID: '' })
    const chat = workInboxCliServer({ ORCA_AGENT_SESSION_ID: 'chat-id' })
    expect(chat.env).toMatchObject({ ORCA_TERMINAL_HANDLE: '', ORCA_AGENT_SESSION_ID: 'chat-id' })
  })
  it.each([
    'claude --append-system-prompt=Original',
    'claude --append-system-prompt-file policy.md'
  ])('preserves existing prompt forms: %s', async (command) => {
    const next = await prepareWorkInboxCliLaunch({
      command,
      agent: 'claude',
      shell: 'posix',
      remote: false
    })
    const parsed = tokenizeStartupCommand(next!, 'posix')
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) {
      throw new Error('Invalid launch')
    }
    if (command.includes('=Original')) {
      expect(
        parsed.tokens.some((token) => token.startsWith('--append-system-prompt=Original '))
      ).toBe(true)
    } else {
      expect(parsed.tokens).toContain('policy.md')
      expect(parsed.tokens).not.toContain('--append-system-prompt')
    }
  })
  it.each(['posix', 'powershell'] as const)(
    'preserves Claude prompt arguments and the option boundary for %s',
    async (shell) => {
      const command = await prepareWorkInboxCliLaunch({
        command: 'claude --append-system-prompt "Original instruction" -- "literal prompt"',
        agent: 'claude',
        shell,
        remote: false,
        env: { ORCA_TERMINAL_HANDLE: 'asking-pane' }
      })
      const parsed = tokenizeStartupCommand(command!, shell)
      expect(parsed.ok).toBe(true)
      if (!parsed.ok) {
        throw new Error('Invalid generated command')
      }
      expect(parsed.tokens.at(-1)).toBe('literal prompt')
      const prompt = parsed.tokens[parsed.tokens.indexOf('--append-system-prompt') + 1]
      expect(prompt).toContain('Original instruction')
      const config = parsed.tokens[parsed.tokens.indexOf('--mcp-config') + 1]
      expect(
        JSON.parse(await readFile(config, 'utf8')).mcpServers.orca_work_inbox.env
          .ORCA_TERMINAL_HANDLE
      ).toBe('asking-pane')
      expect(parsed.tokens.indexOf('--mcp-config')).toBeLessThan(parsed.tokens.indexOf('--'))
    }
  )
  it('does not send local paths to a remote execution host', async () => {
    expect(
      await prepareWorkInboxCliLaunch({
        command: 'claude hello',
        agent: 'claude',
        shell: 'posix',
        remote: true
      })
    ).toBe('claude hello')
    expect(
      withCodexWorkInboxCommand({
        command: 'codex hello',
        agent: 'codex',
        shell: 'posix',
        remote: true
      })
    ).toBe('codex hello')
  })
  it('preserves caller identity without inheriting another session identity', () => {
    const server = workInboxCliServer({ ORCA_TERMINAL_HANDLE: 'same-pane' })
    expect(server.env).toMatchObject({
      ORCA_TERMINAL_HANDLE: 'same-pane',
      ORCA_AGENT_SESSION_ID: '',
      NODE_OPTIONS: '',
      ORCA_USER_DATA_PATH: environment.root
    })
    expect(server.args).toEqual([join(environment.root, 'out', 'cli', 'index.js'), 'inbox', 'mcp'])
    expect(codexWorkInboxLaunchArgs().join(' ')).toContain('env_vars=["ORCA_TERMINAL_HANDLE"')
  })
  it('keeps Claude routing opt-in and preserves existing prompt and tools', () => {
    const options = { systemPrompt: 'Original policy', allowedTools: ['Read'], mcpServers: {} }
    expect(claudeWorkInboxOptions(options, { ORCA_AGENT_SESSION_ID: 'session' })).toEqual({})
    const next = claudeWorkInboxOptions(options, {
      ORCA_AGENT_SESSION_ID: 'session',
      ORCA_WORK_INBOX_ROUTING: '1'
    })
    expect(next.systemPrompt).toContain('Original policy')
    expect(next.allowedTools).toContain('Read')
    expect(next.allowedTools).not.toContain('Bash')
  })
  it('reads effective Codex instructions and fails closed on an invalid response', async () => {
    const request = vi.fn(async () => ({
      config: { developer_instructions: 'Keep existing restrictions' }
    }))
    expect(await codexWorkInboxDeveloperInstructions({ request }, environment.root)).toContain(
      'Keep existing restrictions'
    )
    await expect(
      codexWorkInboxDeveloperInstructions(
        { request: vi.fn(async () => ({ config: { developer_instructions: 123 } })) },
        environment.root
      )
    ).rejects.toThrow('preserve')
  })
})
