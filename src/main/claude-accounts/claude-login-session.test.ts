import { existsSync, mkdtempSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
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

// Why rename: the stand-in hands its link over whole; a direct write lets the poller read it empty.
function handOverClaudeSignInLink(windowsPath: string, link: string): void {
  const helperPath = join(windowsPath, '.orca-sign-in-browser')
  writeFileSync(`${helperPath}.tmp`, link)
  renameSync(`${helperPath}.tmp`, `${helperPath}.link`)
}

// Stands in for Claude running BROWSER with `link`, then finishing once `done` says so.
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

  it('leaves a local login to open its own browser', async () => {
    const config = folder('host')
    const openWslSignInLink = vi.fn()
    const runCommand = vi.fn<RunCommand>(async (_args, _config, _ms, options) => {
      expect(options?.browser).toBeUndefined()
      expect(existsSync(join(config.windowsPath, '.orca-sign-in-browser'))).toBe(false)
      return ''
    })
    await runClaudeLoginSession(config, { runCommand, setCancel: vi.fn(), openWslSignInLink })
    expect(runCommand).toHaveBeenCalledTimes(1)
    expect(openWslSignInLink).not.toHaveBeenCalled()
  })

  it('changes nothing for a WSL login where nothing can open a link', async () => {
    const config = folder('wsl')
    const runCommand = vi.fn<RunCommand>(async () => '')
    await runClaudeLoginSession(config, { runCommand, setCancel: vi.fn() })
    expect(runCommand.mock.calls[0]).toEqual([
      ['auth', 'login', '--claudeai'],
      config,
      expect.any(Number),
      expect.objectContaining({ browser: undefined })
    ])
  })

  it('never opens a link that is not a Claude sign-in, and keeps the login going', async () => {
    const config = folder('wsl')
    const openWslSignInLink = vi.fn()
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const runCommand = claudeHandsOver(config, 'http://claude.com/oauth', () =>
      warn.mock.calls.some(([message]) => String(message).includes('unexpected sign-in link'))
    )
    await expect(
      runClaudeLoginSession(config, { runCommand, setCancel: vi.fn(), openWslSignInLink })
    ).resolves.toBeUndefined()
    expect(openWslSignInLink).not.toHaveBeenCalled()
    warn.mockRestore()
  })

  it('never opens a link for a WSL login the user already cancelled', async () => {
    const config = folder('wsl')
    const openWslSignInLink = vi.fn()
    let cancel: (() => boolean) | null = null
    const runCommand = vi.fn<RunCommand>(async (_args, _config, _ms, options) => {
      // Claude writes its link as the cancel lands.
      handOverClaudeSignInLink(config.windowsPath, LINK)
      expect(cancel?.()).toBe(true)
      expect(options?.signal?.aborted).toBe(true)
      // Give the link watcher its chance to read the file.
      await new Promise((resolve) => setTimeout(resolve, 300))
      throw new Error('Claude sign-in was cancelled.')
    })
    await expect(
      runClaudeLoginSession(config, {
        runCommand,
        setCancel: (next) => {
          cancel ??= next
        },
        openWslSignInLink
      })
    ).rejects.toThrow('cancelled')
    expect(openWslSignInLink).not.toHaveBeenCalled()
  })

  it('runs a WSL login unchanged when the stand-in cannot be written', async () => {
    const config = { ...folder('wsl'), windowsPath: join(tmpdir(), 'missing-claude-folder', 'x') }
    const openWslSignInLink = vi.fn()
    const runCommand = vi.fn<RunCommand>(async () => '')
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    await runClaudeLoginSession(config, { runCommand, setCancel: vi.fn(), openWslSignInLink })
    warn.mockRestore()
    expect(runCommand.mock.calls[0]).toEqual([
      ['auth', 'login', '--claudeai'],
      config,
      expect.any(Number),
      expect.objectContaining({ browser: undefined })
    ])
  })
})
