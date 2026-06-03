import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { prepareLocalCommitMessageAgentEnv } from './commit-message-agent-environment'

const originalEnv = { ...process.env }
const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform')
const tempDirs: string[] = []

afterEach(() => {
  if (originalPlatform) {
    Object.defineProperty(process, 'platform', originalPlatform)
  }
  for (const key of Object.keys(process.env)) {
    if (!(key in originalEnv)) {
      delete process.env[key]
    }
  }
  Object.assign(process.env, originalEnv)
  while (tempDirs.length > 0) {
    rmSync(tempDirs.pop()!, { recursive: true, force: true })
  }
})

function makeHome(): string {
  Object.defineProperty(process, 'platform', { configurable: true, value: 'linux' })
  const dir = mkdtempSync(join(tmpdir(), 'orca-commit-env-'))
  tempDirs.push(dir)
  process.env.HOME = dir
  process.env.SHELL = '/bin/zsh'
  delete process.env.ORCA_OPENCODE_SOURCE_CONFIG_DIR
  delete process.env.ORCA_PI_SOURCE_AGENT_DIR
  return dir
}

describe('prepareLocalCommitMessageAgentEnv', () => {
  it('hydrates OpenCode config dir from shell startup files for headless generation', async () => {
    const home = makeHome()
    delete process.env.OPENCODE_CONFIG_DIR
    writeFileSync(join(home, '.zshrc'), 'export OPENCODE_CONFIG_DIR="$HOME/company/opencode"\n')

    const result = await prepareLocalCommitMessageAgentEnv('opencode', undefined)

    expect(result).toEqual({
      ok: true,
      env: expect.objectContaining({
        OPENCODE_CONFIG_DIR: `${home}/company/opencode`
      })
    })
  })

  it('prefers the original OpenCode config root over inherited PTY overlays', async () => {
    process.env.OPENCODE_CONFIG_DIR = '/tmp/orca-opencode-overlay'
    process.env.ORCA_OPENCODE_SOURCE_CONFIG_DIR = '/Users/tester/company/opencode'

    const result = await prepareLocalCommitMessageAgentEnv('opencode', undefined)

    expect(result).toEqual({
      ok: true,
      env: expect.objectContaining({
        OPENCODE_CONFIG_DIR: '/Users/tester/company/opencode'
      })
    })
  })

  it('hydrates Pi agent dir from shell startup files for headless generation', async () => {
    const home = makeHome()
    delete process.env.PI_CODING_AGENT_DIR
    writeFileSync(join(home, '.zshrc'), 'export PI_CODING_AGENT_DIR="$HOME/.config/pi-agent"\n')

    const result = await prepareLocalCommitMessageAgentEnv('pi', undefined)

    expect(result).toEqual({
      ok: true,
      env: expect.objectContaining({
        PI_CODING_AGENT_DIR: `${home}/.config/pi-agent`
      })
    })
  })

  it('prefers the original Pi agent root over inherited PTY overlays', async () => {
    process.env.PI_CODING_AGENT_DIR = '/tmp/orca-pi-overlay'
    process.env.ORCA_PI_SOURCE_AGENT_DIR = '/Users/tester/.pi/agent'

    const result = await prepareLocalCommitMessageAgentEnv('pi', undefined)

    expect(result).toEqual({
      ok: true,
      env: expect.objectContaining({
        PI_CODING_AGENT_DIR: '/Users/tester/.pi/agent'
      })
    })
  })

  it('does not synthesize env for agents without shell-scoped auth or config roots', async () => {
    makeHome()

    await expect(prepareLocalCommitMessageAgentEnv('cursor', undefined)).resolves.toEqual({
      ok: true
    })
  })

  it('falls back to inherited env when managed account resolvers are unavailable', async () => {
    await expect(prepareLocalCommitMessageAgentEnv('codex', undefined)).resolves.toEqual({
      ok: true
    })
    await expect(prepareLocalCommitMessageAgentEnv('claude', undefined)).resolves.toEqual({
      ok: true
    })
  })

  it('sets CODEX_HOME for host managed Codex accounts', async () => {
    const result = await prepareLocalCommitMessageAgentEnv('codex', {
      prepareForCodexLaunch: () =>
        'C:\\Users\\tester\\AppData\\Roaming\\Orca\\codex-accounts\\a\\home'
    })

    expect(result).toEqual({
      ok: true,
      env: expect.objectContaining({
        CODEX_HOME: 'C:\\Users\\tester\\AppData\\Roaming\\Orca\\codex-accounts\\a\\home'
      })
    })
  })

  it('does not pass WSL managed Codex homes to host-local commit generation', async () => {
    process.env.CODEX_HOME = 'C:\\Users\\tester\\.codex'

    const result = await prepareLocalCommitMessageAgentEnv('codex', {
      prepareForCodexLaunch: () =>
        '\\\\wsl.localhost\\Ubuntu\\home\\tester\\.local\\share\\orca\\codex-accounts\\a\\home'
    })

    expect(result).toEqual({ ok: true })
  })
})
