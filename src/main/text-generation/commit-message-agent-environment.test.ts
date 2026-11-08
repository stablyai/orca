import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { prepareLocalCommitMessageAgentEnv } from './commit-message-agent-environment'
import { ManagedCodexHomeTemporarilyUnavailableError } from '../codex-accounts/host-codex-managed-home-ownership'

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

  // STA-4422: failed managed-home preparation must not fall through to the user's real account while UI shows a managed account.
  it('fails commit generation instead of building a system-account env when the managed home is unreadable', async () => {
    process.env.CODEX_HOME = '/home/me/.config/codex'
    delete process.env.ORCA_CODEX_HOME

    const result = await prepareLocalCommitMessageAgentEnv('codex', {
      prepareForCodexLaunch: () => {
        throw new ManagedCodexHomeTemporarilyUnavailableError()
      }
    })

    expect(result).toEqual({
      ok: false,
      error: 'Failed to prepare the selected agent account for commit message generation.'
    })
    expect(result).not.toHaveProperty('env')
  })

  it('strips a nested-Orca CODEX_HOME override when the launch resolves to the real home', async () => {
    process.env.CODEX_HOME = '/managed/runtime/home'
    process.env.ORCA_CODEX_HOME = '/managed/runtime/home'

    const result = await prepareLocalCommitMessageAgentEnv('codex', {
      prepareForCodexLaunch: () => null
    })

    expect(result.ok).toBe(true)
    const env = (result as { ok: true; env?: NodeJS.ProcessEnv }).env
    expect(env).toBeDefined()
    expect(env?.CODEX_HOME).toBeUndefined()
    expect(env?.ORCA_CODEX_HOME).toBeUndefined()
  })
})
