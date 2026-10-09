import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { prepareClaudeSignInBrowser } from './claude-sign-in-browser'

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

  it('refuses a link that is not a localhost sign-in', async () => {
    const home = folder()
    const browser = await prepareClaudeSignInBrowser({
      windowsPath: home,
      linuxPath: null,
      wslDistro: null
    })
    writeFileSync(`${browser!.path}.link`, 'https://evil.test/oauth/authorize')
    await expect(browser!.nextLink(new AbortController().signal)).resolves.toBeNull()
  })

  it('stops waiting once the sign-in ends', async () => {
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

  it('leaves a Windows host login to open the browser itself', async () => {
    Object.defineProperty(process, 'platform', { value: 'win32' })
    const home = folder()
    await expect(
      prepareClaudeSignInBrowser({ windowsPath: home, linuxPath: null, wslDistro: null })
    ).resolves.toBeNull()
    expect(readdirSync(home)).toEqual([])
  })
})
