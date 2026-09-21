import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { getCliLaunchArgs } from './cli-launch-redirect'
import { argvRequestsServeMode, normalizeServeModeArgv } from './serve-mode-argv'

const CLI_ENTRY_PATH = '/opt/orca/resources/app.asar.unpacked/out/cli/index.js'
const REDIRECT_OPTIONS = {
  platform: 'linux' as const,
  isPackaged: true,
  commandNames: ['serve', 'status']
}

function rewriteAsIndexDoes(argv: string[]): string[] {
  return argvRequestsServeMode(argv) ? normalizeServeModeArgv(argv) : argv
}

describe('serve argv rewrite vs CLI launch redirect ordering', () => {
  const launchArgv = [
    '/opt/orca/orca-ide',
    '--disable-features=Vulkan',
    'serve',
    '--port',
    '7777',
    '--json'
  ]

  it('leaves direct serve in the main process', () => {
    expect(getCliLaunchArgs(launchArgv, CLI_ENTRY_PATH, REDIRECT_OPTIONS)).toBeNull()
  })

  it('rewrites direct serve into the in-process flag shape', () => {
    const rewritten = rewriteAsIndexDoes(launchArgv)
    expect(rewritten).toContain('--disable-features=Vulkan')
    expect(rewritten).toContain('--serve')
    expect(rewritten).toContain('--serve-port')
    expect(getCliLaunchArgs(rewritten, CLI_ENTRY_PATH, REDIRECT_OPTIONS)).toBeNull()
  })

  it('leaves non-serve CLI commands redirectable either way', () => {
    const argv = ['/opt/orca/orca-ide', 'status']
    expect(rewriteAsIndexDoes(argv)).toEqual(argv)
    expect(getCliLaunchArgs(argv, CLI_ENTRY_PATH, REDIRECT_OPTIONS)).toEqual(['status'])
  })

  it('redirects serve help instead of binding a server', () => {
    const argv = ['/opt/orca/orca-ide', 'serve', '--help']
    expect(rewriteAsIndexDoes(argv)).toEqual(argv)
    expect(getCliLaunchArgs(argv, CLI_ENTRY_PATH, REDIRECT_OPTIONS)).toEqual(['serve', '--help'])
  })

  // Why source text: the ordering is the preflight phase's executable statement order, and the
  // cases above stay green if it is reversed — nothing else would catch the regression.
  it('keeps the preflight running the CLI redirect before the argv rewrite', () => {
    const source = readFileSync(
      join(process.cwd(), 'src/main/startup/main-process-preflight.ts'),
      'utf8'
    )
    const cliRedirect = source.indexOf('maybeRedirectCliLaunch({')
    const rewrite = source.indexOf('process.argv = normalizeServeModeArgv(process.argv)')
    const serveModeCheck = source.indexOf("state.isServeMode = process.argv.includes('--serve')")

    expect(cliRedirect).toBeGreaterThanOrEqual(0)
    expect(rewrite).toBeGreaterThan(cliRedirect)
    // The rewrite is pointless unless it lands before the flag it exists to inject is read.
    expect(serveModeCheck).toBeGreaterThan(rewrite)
  })
})
