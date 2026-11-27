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

it("keeps Orca's own forge credentials out of terminals unless the launch passes them (#44365)", () => {
  vi.stubEnv('ORCA_AZURE_DEVOPS_TOKEN', 'inherited-pat')
  vi.stubEnv('ORCA_AZURE_DEVOPS_ACCESS_TOKEN', 'inherited-bearer')
  vi.stubEnv('ORCA_GITEA_TOKEN', 'inherited-gitea')
  vi.stubEnv('ORCA_AZURE_DEVOPS_API_BASE_URL', 'https://ado.example.test/collection')

  const env = createDaemonPtyEnvironment({
    sessionId: 'pane',
    cols: 80,
    rows: 24,
    env: { ORCA_GITEA_TOKEN: 'explicit-gitea' }
  })

  expect(env.ORCA_AZURE_DEVOPS_TOKEN).toBeUndefined()
  expect(env.ORCA_AZURE_DEVOPS_ACCESS_TOKEN).toBeUndefined()
  expect(env.ORCA_GITEA_TOKEN).toBe('explicit-gitea')
  expect(env.ORCA_AZURE_DEVOPS_API_BASE_URL).toBe('https://ado.example.test/collection')
})
