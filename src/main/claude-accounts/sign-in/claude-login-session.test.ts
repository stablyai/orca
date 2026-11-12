import { mkdtempSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'

import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ClaudeCommandConfig, ClaudeCommandOptions } from './claude-command-process'
import { runClaudeLoginSession } from './claude-login-session'

const LINK =
  'https://claude.com/cai/oauth/authorize?code=true&redirect_uri=http%3A%2F%2Flocalhost%3A5000%2Fcallback&state=s'
const LINUX_HOME = '/home/u/claude-profiles/a/home'
const roots: string[] = []
type RunCommand = (
  args: string[],
  config: ClaudeCommandConfig,
  timeoutMs: number,
  options?: ClaudeCommandOptions
) => Promise<string>
afterEach(() => roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })))

function folder(runtime: 'wsl' | 'host'): ClaudeCommandConfig {
  const windowsPath = mkdtempSync(join(tmpdir(), 'claude-login-session-'))
  roots.push(windowsPath)
  return runtime === 'wsl'
    ? { windowsPath, linuxPath: LINUX_HOME, wslDistro: 'Ubuntu' }
    : { windowsPath, linuxPath: null, wslDistro: null }
}

// Publish atomically so the poller cannot read an empty link.
function handOverClaudeSignInLink(windowsPath: string, link: string): void {
  const helperPath = join(windowsPath, '.orca-sign-in-browser')
  writeFileSync(`${helperPath}.tmp`, link)
  renameSync(`${helperPath}.tmp`, `${helperPath}.link`)
}

function claudeHandsOver(config: ClaudeCommandConfig, link: string, done: () => boolean) {
  return vi.fn<RunCommand>(async () => {
    handOverClaudeSignInLink(config.windowsPath, link)
    await vi.waitFor(() => expect(done()).toBe(true))
    return ''
  })
}

describe('runClaudeLoginSession', () => {
  it('opens a WSL login link on this computer and cleans up the stand-in', async () => {
    const config = folder('wsl')
    const openWslSignInLink = vi.fn()
    const runCommand = claudeHandsOver(config, LINK, () => openWslSignInLink.mock.calls.length > 0)
    await runClaudeLoginSession(config, { runCommand, setCancel: vi.fn(), openWslSignInLink })
    expect(runCommand.mock.calls[0][3]).toMatchObject({
      browser: `${LINUX_HOME}/.orca-sign-in-browser`
    })
    expect(openWslSignInLink).toHaveBeenCalledExactlyOnceWith(LINK)
    expect(readdirSync(config.windowsPath)).toEqual([])
  })

  it('copies rather than opens a WSL link when the user asked for Copy link', async () => {
    const config = folder('wsl')
    const openWslSignInLink = vi.fn()
    const onLink = vi.fn()
    const runCommand = claudeHandsOver(config, LINK, () => onLink.mock.calls.length > 0)
    await runClaudeLoginSession(
      config,
      { runCommand, setCancel: vi.fn(), openWslSignInLink },
      onLink
    )
    expect(onLink).toHaveBeenCalledExactlyOnceWith(LINK)
    expect(openWslSignInLink).not.toHaveBeenCalled()
  })
})
