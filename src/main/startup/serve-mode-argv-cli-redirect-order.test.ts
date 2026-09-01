import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { getAppImageCliArgs } from './appimage-cli-redirect'
import { argvRequestsServeMode, normalizeServeModeArgv } from './serve-mode-argv'

// Why: index.ts runs CLI redirects before rewriting argv. Direct AppImage serve
// stays in Electron so launch switches do not cross into the strict Node-mode
// CLI parser; other CLI commands still depend on redirect ordering (#12677).

const REDIRECT_OPTIONS = {
  platform: 'linux' as const,
  isPackaged: true,
  commandNames: ['serve', 'status']
}
// A mounted AppImage is the case where the runtime does export these.
const MOUNTED_APPIMAGE_ENV = { APPIMAGE: '/opt/orca/Orca.AppImage', APPDIR: '/tmp/.mount_ab12' }

function rewriteAsIndexDoes(argv: string[]): string[] {
  return argvRequestsServeMode(argv) ? normalizeServeModeArgv(argv) : argv
}

describe('serve argv rewrite vs AppImage CLI redirect ordering', () => {
  const launchArgv = ['/opt/orca/orca-ide', '--no-sandbox', 'serve', '--port', '7777', '--json']

  it('keeps clean serve validation on the CLI path', () => {
    expect(getAppImageCliArgs(launchArgv, MOUNTED_APPIMAGE_ENV, REDIRECT_OPTIONS)).toEqual([
      'serve',
      '--port',
      '7777',
      '--json'
    ])
  })

  it('keeps an injected Chromium switch in Electron before argv rewriting', () => {
    const injected = [...launchArgv.slice(0, 2), '--disable-features=FedCm', ...launchArgv.slice(2)]
    expect(getAppImageCliArgs(injected, MOUNTED_APPIMAGE_ENV, REDIRECT_OPTIONS)).toBeNull()
  })

  it('loses the redirect if the rewrite runs first', () => {
    const rewritten = rewriteAsIndexDoes(launchArgv)
    expect(rewritten).toContain('--serve')
    expect(getAppImageCliArgs(rewritten, MOUNTED_APPIMAGE_ENV, REDIRECT_OPTIONS)).toBeNull()
  })

  it('leaves non-serve CLI commands redirectable either way', () => {
    const argv = ['/opt/orca/orca-ide', 'status']
    expect(rewriteAsIndexDoes(argv)).toEqual(argv)
    expect(getAppImageCliArgs(argv, MOUNTED_APPIMAGE_ENV, REDIRECT_OPTIONS)).toEqual(['status'])
  })

  // Why source text: the ordering is the preflight phase's executable statement order, and the
  // cases above stay green if it is reversed — nothing else would catch the regression.
  it('keeps the preflight running both CLI redirects before the argv rewrite', () => {
    const source = readFileSync(
      join(process.cwd(), 'src/main/startup/main-process-preflight.ts'),
      'utf8'
    )
    const packagedRedirect = source.indexOf('maybeRedirectPackagedCliEntryLaunch({')
    const appImageRedirect = source.indexOf('maybeRedirectAppImageCliLaunch({')
    const rewrite = source.indexOf('process.argv = normalizeServeModeArgv(process.argv)')
    const serveModeCheck = source.indexOf("state.isServeMode = process.argv.includes('--serve')")

    expect(packagedRedirect).toBeGreaterThanOrEqual(0)
    expect(appImageRedirect).toBeGreaterThanOrEqual(0)
    expect(rewrite).toBeGreaterThan(packagedRedirect)
    expect(rewrite).toBeGreaterThan(appImageRedirect)
    // The rewrite is pointless unless it lands before the flag it exists to inject is read.
    expect(serveModeCheck).toBeGreaterThan(rewrite)
  })
})
