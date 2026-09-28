import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { prepareSmokeKeychain } from './runtime-serve-smoke-keychain.mjs'

const execute = vi.fn()
const roots = []
afterEach(() => {
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
  vi.resetAllMocks()
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true })
  }
})
function setup() {
  const home = mkdtempSync(join(tmpdir(), 'orca-smoke-keychain-'))
  roots.push(home)
  vi.stubGlobal('process', { ...process, platform: 'darwin' })
  vi.stubEnv('CI', 'true')
  execute.mockReturnValue({
    code: 0,
    stdout: '"/original/login.keychain-db"',
    timedOut: false
  })
  return home
}
it('never changes the developer desktop keychain', () => {
  const home = setup()
  vi.stubEnv('CI', '')
  expect(prepareSmokeKeychain(home, execute)).toBeUndefined()
  expect(execute).not.toHaveBeenCalled()
})
it('restores the previous default and deletes only its disposable keychain', () => {
  const home = setup()
  const cleanup = prepareSmokeKeychain(home, execute)
  cleanup()
  const calls = execute.mock.calls.map(([spec]) => spec)
  expect(calls.every((spec) => spec.env.HOME === home)).toBe(true)
  expect(calls.slice(-2).map((spec) => spec.args)).toEqual([
    ['default-keychain', '-d', 'user', '-s', '/original/login.keychain-db'],
    ['delete-keychain', join(home, 'Library', 'Keychains', 'login.keychain-db')]
  ])
})
it('cleans up a keychain when unlocking fails without exposing its password', () => {
  const home = setup()
  execute.mockImplementation(({ args }) => ({
    code: args[0] === 'unlock-keychain' ? 1 : 0,
    stdout: '"/original/login.keychain-db"',
    timedOut: false
  }))
  expect(() => prepareSmokeKeychain(home, execute)).toThrow('operation failed: unlock-keychain')
  expect(execute.mock.lastCall[0].args[0]).toBe('delete-keychain')
})
