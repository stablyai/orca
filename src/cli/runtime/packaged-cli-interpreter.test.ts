import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { accessSync } from 'node:fs'
import type * as Fs from 'node:fs'

vi.mock('node:fs', async (importOriginal) => ({
  ...(await importOriginal<typeof Fs>()),
  accessSync: vi.fn()
}))

const platform = process.platform
const argv = process.argv
const execve = Object.getOwnPropertyDescriptor(process, 'execve')
beforeEach(() => {
  Object.defineProperty(process, 'execve', {
    configurable: true,
    writable: true,
    value: vi.fn(() => {
      throw new Error('Unexpected native replacement')
    })
  })
})
afterEach(() => {
  Object.defineProperty(process, 'platform', { value: platform })
  process.argv = argv
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
  if (execve) {
    Object.defineProperty(process, 'execve', execve)
  } else {
    delete process.execve
  }
  vi.mocked(accessSync).mockReset()
  vi.resetModules()
})

it('consumes the shim marker before replacing a lifecycle command with root Electron', async () => {
  Object.defineProperty(process, 'platform', { value: 'darwin' })
  process.argv = ['/helper/node', '/app/cli.js', 'open', '--json']
  vi.stubEnv('ORCA_CLI_ELECTRON_EXECUTABLE', '/Applications/Orca.app/Contents/MacOS/Orca')
  vi.stubEnv('ORCA_NODE_OPTIONS', '--max-old-space-size=2048')
  const replaced = new Error('Process replaced')
  let invocation:
    | { file: string; args: readonly string[] | undefined; env: NodeJS.ProcessEnv | undefined }
    | undefined
  vi.spyOn(process, 'execve').mockImplementation((file, args, env) => {
    invocation = { file, args, env }
    throw replaced
  })
  vi.resetModules()
  const { reenterPackagedElectron } = await import('./packaged-cli-interpreter')
  expect(process.env.ORCA_CLI_ELECTRON_EXECUTABLE).toBeUndefined()
  expect(reenterPackagedElectron).toThrow(replaced)
  expect(invocation).toMatchObject({
    file: '/Applications/Orca.app/Contents/MacOS/Orca',
    args: ['/Applications/Orca.app/Contents/MacOS/Orca', '/app/cli.js', 'open', '--json'],
    env: { ELECTRON_RUN_AS_NODE: '1', ORCA_NODE_OPTIONS: '--max-old-space-size=2048' }
  })
  expect(invocation?.env).not.toHaveProperty('ORCA_CLI_ELECTRON_EXECUTABLE')
})

it('reports an unavailable app before attempting native process replacement', async () => {
  Object.defineProperty(process, 'platform', { value: 'darwin' })
  process.argv = ['/helper/node', '/app/cli.js', 'open']
  vi.stubEnv('ORCA_CLI_ELECTRON_EXECUTABLE', '/missing/Orca')
  vi.mocked(accessSync).mockImplementation(() => {
    throw new Error('ENOENT')
  })
  vi.spyOn(process, 'execve').mockImplementation(() => {
    throw new Error('Native replacement attempted')
  })
  vi.resetModules()
  const { reenterPackagedElectron } = await import('./packaged-cli-interpreter')
  expect(reenterPackagedElectron).toThrow('The installed Orca app is unavailable')
})
