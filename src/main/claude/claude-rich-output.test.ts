import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import { applyClaudeRichOutputEnv } from './claude-rich-output'
import { resolveTuiAgentLaunchEnv } from '../../shared/tui-agent-launch-defaults'
import type { BuildPtyHostEnvOptions } from '../ipc/pty/host-env/types'

const temporary: string[] = []
afterEach(() => {
  for (const path of temporary.splice(0)) {
    rmSync(path, { recursive: true, force: true })
  }
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
})

function bundle() {
  const root = mkdtempSync(join(tmpdir(), 'orca-rich-output-'))
  temporary.push(root)
  for (const name of ['reply-markdown', 'reply-media']) {
    mkdirSync(join(root, name, '.claude-plugin'), { recursive: true })
    writeFileSync(join(root, name, '.claude-plugin', 'plugin.json'), JSON.stringify({ name }))
  }
  return root
}
const options: BuildPtyHostEnvOptions = {
  isPackaged: true,
  userDataPath: '/unused',
  selectedCodexHomePath: null,
  agentStatusHooksEnabled: false,
  launchAgent: 'claude'
}

const apply = (
  env: Record<string, string>,
  launch: Parameters<typeof applyClaudeRichOutputEnv>[1],
  roots: readonly string[]
) => applyClaudeRichOutputEnv(env, launch, roots, {})

describe('opt-in Claude rich output', () => {
  it('isolates launch fixtures from an enclosing rich-output terminal', async () => {
    const root = bundle()
    const inherited = join(root, 'foreign-user-plugin')
    const overlay = [inherited, join(root, 'foreign-overlay')].join(delimiter)
    vi.stubEnv('CLAUDE_CODE_PLUGIN_DIRS', overlay)
    vi.stubEnv('ORCA_CLAUDE_PLUGIN_DIRS', overlay)
    vi.stubEnv('ORCA_CLAUDE_SOURCE_PLUGIN_DIRS', inherited)
    const env: Record<string, string> = {
      CLAUDE_CONFIG_DIR: join(root, 'config'),
      ORCA_CLAUDE_RICH_OUTPUT: '1'
    }
    await apply(env, { ...options, cwd: root, isWsl: true }, [root])
    expect(env.CLAUDE_CODE_PLUGIN_DIRS).toBeUndefined()
    env.ORCA_CLAUDE_RICH_OUTPUT = '1'
    await apply(env, { ...options, cwd: root }, [root])
    expect(env.CLAUDE_CODE_PLUGIN_DIRS.split(delimiter)).toEqual([
      join(root, 'reply-markdown'),
      join(root, 'reply-media')
    ])
    expect(env.ORCA_CLAUDE_SOURCE_PLUGIN_DIRS).toBeUndefined()
  })

  it('leaves the default launch and other agents unchanged; explicit env overrides the switch', () => {
    expect(resolveTuiAgentLaunchEnv('claude', { claudeRichOutput: false })).toEqual(
      resolveTuiAgentLaunchEnv('claude', undefined)
    )
    expect(resolveTuiAgentLaunchEnv('codex', { claudeRichOutput: true })).toEqual(
      resolveTuiAgentLaunchEnv('codex', undefined)
    )
    expect(
      resolveTuiAgentLaunchEnv('claude', { claudeRichOutput: true }).ORCA_CLAUDE_RICH_OUTPUT
    ).toBe('1')
    expect(
      resolveTuiAgentLaunchEnv('claude', {
        claudeRichOutput: true,
        agentDefaultEnv: { claude: { ORCA_CLAUDE_RICH_OUTPUT: '0' } }
      }).ORCA_CLAUDE_RICH_OUTPUT
    ).toBe('0')
  })

  it('resolves modules on the execution host and preserves user plugins without duplicate injection', async () => {
    const root = bundle()
    const user = join(root, 'user-plugin')
    const env: Record<string, string> = {
      CLAUDE_CONFIG_DIR: join(root, 'config'),
      ORCA_CLAUDE_RICH_OUTPUT: '1',
      CLAUDE_CODE_PLUGIN_DIRS: user
    }
    await apply(env, { ...options, cwd: root }, [join(root, 'missing-client-path'), root])
    expect(env.ORCA_CLAUDE_RICH_OUTPUT).toBeUndefined()
    env.ORCA_CLAUDE_RICH_OUTPUT = '1'
    await apply(env, { ...options, cwd: root }, [root])
    expect(env.CLAUDE_CODE_PLUGIN_DIRS.split(delimiter)).toEqual([
      user,
      join(root, 'reply-markdown'),
      join(root, 'reply-media')
    ])
    env.ORCA_CLAUDE_RICH_OUTPUT = '0'
    await apply(env, { ...options, cwd: root }, [root])
    expect(env.CLAUDE_CODE_PLUGIN_DIRS).toBe(user)
    expect(env.ORCA_CLAUDE_PLUGIN_DIRS).toBeUndefined()
  })

  it('does not pass Windows paths into WSL or silently install when the host bundle is missing', async () => {
    const root = bundle()
    const env: Record<string, string> = {
      ORCA_CLAUDE_RICH_OUTPUT: '1',
      CLAUDE_CONFIG_DIR: join(root, 'config')
    }
    await apply(env, { ...options, cwd: root, isWsl: true }, [root])
    expect(env.CLAUDE_CODE_PLUGIN_DIRS).toBeUndefined()
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {})
    env.ORCA_CLAUDE_RICH_OUTPUT = '1'
    await apply(env, { ...options, cwd: root }, [])
    expect(env.CLAUDE_CODE_PLUGIN_DIRS).toBeUndefined()
    expect(warning).toHaveBeenCalledOnce()
  })

  it('keeps an existing user NeonCoat module instead of loading a second copy', async () => {
    const root = bundle()
    const userRoot = bundle()
    const userMarkdown = join(userRoot, 'reply-markdown')
    const env: Record<string, string> = {
      CLAUDE_CONFIG_DIR: join(root, 'config'),
      ORCA_CLAUDE_RICH_OUTPUT: '1',
      CLAUDE_CODE_PLUGIN_DIRS: userMarkdown
    }
    await apply(env, { ...options, cwd: root }, [root])
    expect(env.CLAUDE_CODE_PLUGIN_DIRS.split(delimiter)).toEqual([
      userMarkdown,
      join(root, 'reply-media')
    ])
    env.ORCA_CLAUDE_RICH_OUTPUT = '1'
    await apply(env, { ...options, cwd: root }, [root])
    expect(env.CLAUDE_CODE_PLUGIN_DIRS.split(delimiter)).toEqual([
      userMarkdown,
      join(root, 'reply-media')
    ])
    await apply(env, { ...options, cwd: root }, [root])
    expect(env.CLAUDE_CODE_PLUGIN_DIRS).toBe(userMarkdown)
  })

  it('keeps an explicit user replacement while stripping a prior Orca overlay', async () => {
    const root = bundle()
    const env: Record<string, string> = {
      ORCA_CLAUDE_RICH_OUTPUT: '1',
      CLAUDE_CONFIG_DIR: join(root, 'config')
    }
    await apply(env, { ...options, cwd: root }, [root])
    env.CLAUDE_CODE_PLUGIN_DIRS = 'user-replacement'
    env.ORCA_CLAUDE_RICH_OUTPUT = '0'
    await apply(env, { ...options, cwd: root }, [root])
    expect(env.CLAUDE_CODE_PLUGIN_DIRS).toBe('user-replacement')
  })
})

it.each([undefined, ''])('keeps the ordinary launch when cwd is unknown (%s)', async (cwd) => {
  const root = bundle()
  const userPlugin = join(root, 'user-plugin')
  const previousOverlay = [userPlugin, join(root, 'reply-markdown')].join(delimiter)
  const env: Record<string, string> = {
    CLAUDE_CONFIG_DIR: join(root, 'config'),
    ORCA_CLAUDE_RICH_OUTPUT: '1',
    CLAUDE_CODE_PLUGIN_DIRS: previousOverlay,
    ORCA_CLAUDE_PLUGIN_DIRS: previousOverlay,
    ORCA_CLAUDE_SOURCE_PLUGIN_DIRS: userPlugin
  }
  await apply(env, { ...options, cwd }, [root])
  expect(env.CLAUDE_CODE_PLUGIN_DIRS).toBe(userPlugin)
  expect(env.ORCA_CLAUDE_PLUGIN_DIRS).toBeUndefined()
  expect(env.ORCA_CLAUDE_SOURCE_PLUGIN_DIRS).toBeUndefined()
  expect(env.ORCA_CLAUDE_RICH_OUTPUT).toBeUndefined()
})
