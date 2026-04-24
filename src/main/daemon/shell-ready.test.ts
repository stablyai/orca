import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { tmpdir } from 'os'
import { join } from 'path'
import { existsSync, mkdtempSync, rmSync } from 'fs'
import type * as ShellReadyModule from './shell-ready'

async function importFreshShellReady(): Promise<typeof ShellReadyModule> {
  vi.resetModules()
  return import('./shell-ready')
}

const describePosix = process.platform === 'win32' ? describe.skip : describe

describePosix('daemon shell-ready launch config', () => {
  let previousUserDataPath: string | undefined
  let userDataPath: string

  beforeEach(() => {
    previousUserDataPath = process.env.ORCA_USER_DATA_PATH
    userDataPath = mkdtempSync(join(tmpdir(), 'daemon-shell-ready-test-'))
    process.env.ORCA_USER_DATA_PATH = userDataPath
  })

  afterEach(() => {
    if (previousUserDataPath === undefined) {
      delete process.env.ORCA_USER_DATA_PATH
    } else {
      process.env.ORCA_USER_DATA_PATH = previousUserDataPath
    }
    rmSync(userDataPath, { recursive: true, force: true })
    vi.restoreAllMocks()
  })

  it('stores wrapper rcfiles under durable userData instead of tmp', async () => {
    const { getShellReadyLaunchConfig } = await importFreshShellReady()

    const config = getShellReadyLaunchConfig('/bin/bash')
    const rcfile = join(userDataPath, 'shell-ready', 'bash', 'rcfile')

    expect(config.args).toEqual(['--rcfile', rcfile])
    expect(existsSync(rcfile)).toBe(true)
  })

  it('rewrites wrappers when a long-lived daemon finds a missing rcfile', async () => {
    const { getShellReadyLaunchConfig } = await importFreshShellReady()
    const rcfile = join(userDataPath, 'shell-ready', 'bash', 'rcfile')

    getShellReadyLaunchConfig('/bin/bash')
    rmSync(rcfile)

    expect(existsSync(rcfile)).toBe(false)
    getShellReadyLaunchConfig('/bin/bash')
    expect(existsSync(rcfile)).toBe(true)
  })

  it('points zsh launch config at durable wrapper files', async () => {
    const { getShellReadyLaunchConfig } = await importFreshShellReady()

    const config = getShellReadyLaunchConfig('/bin/zsh')

    expect(config.args).toEqual(['-l'])
    expect(config.env.ZDOTDIR).toBe(join(userDataPath, 'shell-ready', 'zsh'))
    expect(existsSync(join(userDataPath, 'shell-ready', 'zsh', '.zshenv'))).toBe(true)
  })
})
