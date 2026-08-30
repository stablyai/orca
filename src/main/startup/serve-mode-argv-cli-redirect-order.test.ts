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
  const launchArgv = ['/opt/orca/orca-ide', '--no-sandbox', 'serve', '--port', '7777', '--json']

  it('leaves direct serve in the main process', () => {
    expect(getCliLaunchArgs(launchArgv, CLI_ENTRY_PATH, REDIRECT_OPTIONS)).toBeNull()
  })

  it('rewrites direct serve into the in-process flag shape', () => {
    const rewritten = rewriteAsIndexDoes(launchArgv)
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
})
