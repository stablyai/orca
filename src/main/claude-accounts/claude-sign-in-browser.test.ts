import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readdirSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { isClaudeLocalSignInLink, prepareClaudeSignInBrowser } from './claude-sign-in-browser'

const LINK =
  'https://claude.com/cai/oauth/authorize?code=true&redirect_uri=http%3A%2F%2Flocalhost%3A5000%2Fcallback&state=s'
const roots: string[] = []
const originalPlatform = process.platform
afterEach(() => {
  Object.defineProperty(process, 'platform', { value: originalPlatform })
  roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true }))
})

function folder(): string {
  const root = mkdtempSync(join(tmpdir(), 'claude-sign-in-browser-'))
  roots.push(root)
  return root
}

describe('prepareClaudeSignInBrowser', () => {
  it.skipIf(process.platform === 'win32')(
    'hands the link Claude gives BROWSER to Orca and leaves nothing behind',
    async () => {
      const home = folder()
      const browser = await prepareClaudeSignInBrowser({
        windowsPath: home,
        linuxPath: null,
        wslDistro: null
      })
      expect(browser?.path).toBe(join(home, '.orca-sign-in-browser'))
      expect(statSync(browser!.path).mode & 0o700).toBe(0o700)
      const next = browser!.nextLink(new AbortController().signal)
      // Claude runs BROWSER as a program with the link as its only argument.
      execFileSync(browser!.path, [LINK])
      await expect(next).resolves.toBe(LINK)
      await browser!.dispose()
      expect(readdirSync(home)).toEqual([])
    }
  )

  it.skipIf(process.platform === 'win32')('stops waiting once the sign-in ends', async () => {
    const home = folder()
    const browser = await prepareClaudeSignInBrowser({
      windowsPath: home,
      linuxPath: null,
      wslDistro: null
    })
    const stop = new AbortController()
    const next = browser!.nextLink(stop.signal)
    stop.abort()
    await expect(next).resolves.toBeNull()
  })

  it("points a WSL login's BROWSER at the distro path of the same file", async () => {
    Object.defineProperty(process, 'platform', { value: 'win32' })
    const home = folder()
    const browser = await prepareClaudeSignInBrowser({
      windowsPath: home,
      linuxPath: '/home/u/claude-profiles/a/home',
      wslDistro: 'Ubuntu'
    })
    expect(browser?.path).toBe('/home/u/claude-profiles/a/home/.orca-sign-in-browser')
    expect(existsSync(join(home, '.orca-sign-in-browser'))).toBe(true)
  })

  it('refuses to catch a Windows host login, whose Claude cannot run the stand-in', async () => {
    Object.defineProperty(process, 'platform', { value: 'win32' })
    const home = folder()
    await expect(
      prepareClaudeSignInBrowser({ windowsPath: home, linuxPath: null, wslDistro: null })
    ).rejects.toThrow('Claude sign-in failed. Please try again.')
    expect(readdirSync(home)).toEqual([])
  })
})

describe('isClaudeLocalSignInLink', () => {
  const link = (base: string, redirect: string): string =>
    `${base}?redirect_uri=${encodeURIComponent(redirect)}&state=s`

  it('accepts the link Claude hands BROWSER', () => {
    expect(isClaudeLocalSignInLink(LINK)).toBe(true)
    expect(
      isClaudeLocalSignInLink(
        link('https://claude.ai/oauth/authorize', 'http://127.0.0.1:1/callback')
      )
    ).toBe(true)
  })

  it('refuses the printed pasted-code link and anything not from Claude', () => {
    const authorize = 'https://claude.com/cai/oauth/authorize'
    expect(
      isClaudeLocalSignInLink(link(authorize, 'https://platform.claude.com/oauth/code/callback'))
    ).toBe(false)
    expect(isClaudeLocalSignInLink(link(authorize, 'http://attacker.test/callback'))).toBe(false)
    expect(
      isClaudeLocalSignInLink(
        link('https://claude.com.evil.test/oauth/authorize', 'http://localhost:1/callback')
      )
    ).toBe(false)
    expect(
      isClaudeLocalSignInLink(
        link('http://claude.com/cai/oauth/authorize', 'http://localhost:1/callback')
      )
    ).toBe(false)
    expect(isClaudeLocalSignInLink('not a url')).toBe(false)
  })
})
