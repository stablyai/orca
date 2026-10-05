import { describe, expect, it, vi } from 'vitest'
import { createPtyShellLaunchPlan } from './daemon/pty-subprocess/shell-launch-plan'
import { FISH_XDG_DATA_DIRS_PREFIX_ENV } from './fish-xdg-data-dirs-handoff'
import { finalizeLocalPtySpawnEnvironment } from './providers/local-pty-finalize-environment'
import { createLocalPtyLaunchPlan } from './providers/local-pty-launch-plan'
import type * as LocalPtyUtils from './providers/local-pty-utils'

// Why: the fish path need not exist on the test host; only the spawn env is asserted.
vi.mock('./providers/local-pty-utils', async (importOriginal) => ({
  ...(await importOriginal<typeof LocalPtyUtils>()),
  resolveUnixShellPath: (shellPath: string) => shellPath,
  ensureNodePtySpawnHelperExecutable: vi.fn(),
  validateWorkingDirectory: vi.fn()
}))

const FISH = '/usr/bin/fish'
const INHERITED = '/opt/a:/opt/b'

function daemonEnv(terminalShellArgs: string[]): Record<string, string> {
  const env: Record<string, string> = {
    HOME: '/home/jin',
    XDG_DATA_DIRS: INHERITED
  }
  const plan = createPtyShellLaunchPlan(
    {
      sessionId: 's',
      cols: 80,
      rows: 24,
      cwd: '/tmp',
      shellOverride: FISH,
      terminalShellArgs
    },
    env
  )
  expect(plan.shellArgs).toEqual(terminalShellArgs)
  return env
}

function localEnv(terminalShellArgs: string[]): Record<string, string> {
  const spawn = {
    cwd: '/tmp',
    cols: 80,
    rows: 24,
    shellOverride: FISH,
    terminalShellArgs
  }
  const getOptions = () => ({ getDefaultShell: () => FISH })
  const plan = createLocalPtyLaunchPlan(spawn, getOptions)
  const env: Record<string, string> = {
    HOME: '/home/jin',
    XDG_DATA_DIRS: INHERITED
  }
  if (!('shellArgs' in plan)) {
    throw new Error('expected an immediate POSIX launch plan')
  }
  finalizeLocalPtySpawnEnvironment({ spawn, getOptions, plan, env })
  expect(plan.shellArgs).toEqual(terminalShellArgs)
  return env
}

describe.skipIf(process.platform === 'win32').each([
  ['daemon', daemonEnv],
  ['local', localEnv]
])('%s fish spawn', (_name, launchEnv) => {
  // Why: fish skips vendor_conf.d under -N, so nothing would ever undo the prefix.
  it('leaves XDG_DATA_DIRS alone for -N', () => {
    const env = launchEnv(['-l', '-N'])
    expect(env.XDG_DATA_DIRS).toBe(INHERITED)
    expect(env[FISH_XDG_DATA_DIRS_PREFIX_ENV]).toBeUndefined()
  })

  it('still hands off for a plain login fish', () => {
    const env = launchEnv(['-l'])
    expect(env[FISH_XDG_DATA_DIRS_PREFIX_ENV]).toMatch(/\/fish-xdg-data$/)
    expect(env.XDG_DATA_DIRS).toBe(`${env[FISH_XDG_DATA_DIRS_PREFIX_ENV]}:${INHERITED}`)
  })
})
