import { afterEach, expect, it, vi } from 'vitest'

const { clientArgs } = vi.hoisted((): { clientArgs: unknown[][] } => ({ clientArgs: [] }))
vi.mock('../runtime/client.js', () => ({
  RuntimeClient: class {
    constructor(...args: unknown[]) {
      clientArgs.push(args)
    }
    call(): Promise<never> {
      return Promise.reject(new Error('no runtime'))
    }
  }
}))

afterEach(() => {
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
})

it('keeps --profile in the args that recovery commands repeat', async () => {
  // An ambient profile must not take over a printed retry of `--profile default`.
  for (const key of ['ORCA_PROFILE', 'ORCA_USER_DATA_PATH', 'ORCA_APP_EXECUTABLE']) {
    vi.stubEnv(key, key === 'ORCA_PROFILE' ? 'work' : undefined)
  }
  vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
  vi.spyOn(console, 'error').mockImplementation(() => {})
  const { main } = await import('../index.js')
  const argv = ['--profile', 'default', 'orchestration', 'worker-stop', '--dispatch', 'd1']
  await main(argv, '/')
  process.exitCode = 0
  expect(clientArgs.at(-1)?.[5]).toEqual(argv)
})
