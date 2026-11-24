import { afterEach, expect, it, vi } from 'vitest'
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
