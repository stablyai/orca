import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildPtyHostEnv } from './assembly'
import type { BuildPtyHostEnvOptions } from './types'

const fixture = vi.hoisted(() => ({ userData: '' }))
vi.mock('../../../../shared/app-environment', () => ({
  getAppEnvironment: () => ({ getPath: () => fixture.userData, onWillQuit: vi.fn() })
}))
vi.mock('../../../agent-hooks/server/agent-hook-server', () => ({
  agentHookServer: { buildPtyEnv: () => ({ ORCA_AGENT_HOOK_PORT: '12345' }) }
}))
vi.mock('../../../cli/launchers/orca-cli-child-path', () => ({
  prependOrcaCliDirToChildPath: () => {}
}))

let root: string
let home: string
let options: BuildPtyHostEnvOptions

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'orca-gentle-shell-env-'))
  home = join(root, 'home')
  mkdirSync(home)
  fixture.userData = join(root, 'user-data')
  mkdirSync(fixture.userData)
  vi.stubEnv('HOME', home)
  vi.stubEnv('USERPROFILE', home)
  vi.stubEnv('ZDOTDIR', undefined)
  vi.stubEnv('ORCA_GENTLE_SHELL_STATUS_EXTENSION', undefined)
  options = {
    isPackaged: true,
    userDataPath: fixture.userData,
    selectedCodexHomePath: null,
    agentStatusHooksEnabled: true
  }
})
afterEach(() => {
  vi.unstubAllEnvs()
  rmSync(root, { recursive: true, force: true })
})

describe('gentle-shell status extension pane env', () => {
  it.each([
    ['a bare shell', undefined],
    ['an explicit gentle-shell launch', 'gentle-shell --resume']
  ])('exposes a userData extension path for %s', (_label, launchCommand) => {
    const env = buildPtyHostEnv('pty-1', {}, { ...options, launchCommand })

    const extensionPath = env.ORCA_GENTLE_SHELL_STATUS_EXTENSION
    expect(extensionPath?.startsWith(fixture.userData)).toBe(true)
    expect(existsSync(extensionPath!)).toBe(true)
    expect(existsSync(join(home, '.gentle-shell'))).toBe(false)
  })

  it('omits the extension for other agent launches and when hooks are disabled', () => {
    expect(
      buildPtyHostEnv('pty-2', {}, { ...options, launchCommand: 'claude' })
        .ORCA_GENTLE_SHELL_STATUS_EXTENSION
    ).toBeUndefined()
    expect(
      buildPtyHostEnv(
        'pty-3',
        { ORCA_GENTLE_SHELL_STATUS_EXTENSION: '/stale/orca-agent-status.ts' },
        { ...options, agentStatusHooksEnabled: false, launchCommand: 'gentle-shell' }
      ).ORCA_GENTLE_SHELL_STATUS_EXTENSION
    ).toBeUndefined()
  })
})
