import { afterEach, expect, it, vi } from 'vitest'
import { createPtyShellLaunchPlan } from './shell-launch-plan'
import { createDaemonPtyEnvironment } from './spawn-environment'

afterEach(() => {
  vi.unstubAllEnvs()
})

it('drops the inherited Chromium crashpad pipe but keeps an explicit one (#19792)', () => {
  vi.stubEnv('Chrome_Crashpad_Pipe_Name', '\\\\.\\pipe\\crashpad_999999_DEADBEEFCAFEBABE')

  const env = createDaemonPtyEnvironment({
    sessionId: 'pane',
    cols: 80,
    rows: 24,
    env: { CHROME_CRASHPAD_PIPE_NAME: 'explicit' }
  })

  expect(
    Object.entries(env).filter(([key]) => key.toUpperCase() === 'CHROME_CRASHPAD_PIPE_NAME')
  ).toEqual([['CHROME_CRASHPAD_PIPE_NAME', 'explicit']])
})

it.skipIf(process.platform !== 'win32')(
  'exports the pane handle from a daemon PowerShell PTY (#49580)',
  () => {
    const opts = {
      sessionId: 'pane',
      cols: 80,
      rows: 24,
      cwd: 'C:\\work',
      shellOverride: 'powershell.exe',
      env: { ORCA_TERMINAL_HANDLE: 'term_daemon', ORCA_RUNTIME_SOURCE_ID: 'install-1' }
    }
    const env = createDaemonPtyEnvironment(opts)
    createPtyShellLaunchPlan(opts, env)

    expect(env.WSLENV?.split(':')).toEqual(
      expect.arrayContaining(['ORCA_TERMINAL_HANDLE/u', 'ORCA_RUNTIME_SOURCE_ID/u'])
    )
  }
)
