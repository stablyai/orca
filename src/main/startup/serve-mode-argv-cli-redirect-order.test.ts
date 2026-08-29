import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { getAppImageCliArgs } from './appimage-cli-redirect'
import { argvRequestsServeMode, normalizeServeModeArgv } from './serve-mode-argv'

// Why: index.ts must run both CLI redirects before rewriting argv. Rewriting
// first replaces the `serve` positional with `--serve`, so the redirect's
// command-name lookup finds a port number instead of a command and bails —
// silently dropping AppImage serve launches out of the CLI path (#12677).

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

  it('hands the launch argv to the CLI when the redirect runs first', () => {
    expect(getAppImageCliArgs(launchArgv, MOUNTED_APPIMAGE_ENV, REDIRECT_OPTIONS)).toEqual([
      'serve',
      '--port',
      '7777',
      '--json'
    ])
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

  // Why source text: the ordering only exists as statement order at index.ts module scope, and the
  // cases above stay green if it is reversed — nothing else would catch the regression.
  it('keeps index.ts running both CLI redirects before the argv rewrite', () => {
    const source = readFileSync(join(process.cwd(), 'src/main/index.ts'), 'utf8')
    const packagedRedirect = source.indexOf('maybeRedirectPackagedCliEntryLaunch({')
    const appImageRedirect = source.indexOf('maybeRedirectAppImageCliLaunch({')
    const rewrite = source.indexOf('process.argv = normalizeServeModeArgv(process.argv)')
    const serveModeCheck = source.indexOf("const isServeMode = process.argv.includes('--serve')")

    expect(packagedRedirect).toBeGreaterThanOrEqual(0)
    expect(appImageRedirect).toBeGreaterThanOrEqual(0)
    expect(rewrite).toBeGreaterThan(packagedRedirect)
    expect(rewrite).toBeGreaterThan(appImageRedirect)
    // The rewrite is pointless unless it lands before the flag it exists to inject is read.
    expect(serveModeCheck).toBeGreaterThan(rewrite)
  })
})
