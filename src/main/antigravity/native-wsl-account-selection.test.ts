import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { createHash } from 'node:crypto'
import { runProcess } from '../../shared/child-process/run-process'
import type * as NativeAccountHost from './native-account-host'
import { credential, harness } from './native-account-test-fixtures'
import { withAntigravityAccountOperation } from './native-account-service'

const mocks = vi.hoisted(() => ({ run: vi.fn(), store: vi.fn() }))
vi.mock('../../shared/child-process/run-process', () => ({ runProcess: mocks.run }))
vi.mock('../../shared/app-environment', () => ({
  getAppEnvironment: () => ({ getPath: () => '/test/user-data' })
}))
vi.mock('./native-account-store', () => ({ createEncryptedAntigravityAccountStore: mocks.store }))
vi.mock('../wsl/wsl-executable-path', () => ({ resolveWslExecutablePath: () => 'wsl.exe' }))

let host: typeof NativeAccountHost
let saved: ReturnType<typeof harness>
let accountId: string
let native: string
let uid: number
let launches: string[]
let credentialInputs: string[]
const authorityId = createHash('sha256')
  .update(JSON.stringify(['v1', 'wsl', 'ubuntu', 1000, '/home/u']))
  .digest('hex')
const target = { runtime: 'wsl', wslDistro: 'Ubuntu', expectedAuthorityId: authorityId } as const

beforeEach(async () => {
  vi.resetModules()
  vi.clearAllMocks()
  vi.spyOn(process, 'platform', 'get').mockReturnValue('win32')
  saved = harness(credential('b'))
  accountId = (await saved.service.addCurrentAccount()).accounts[0].id
  native = credential('a')
  uid = 1000
  launches = []
  credentialInputs = []
  mocks.store.mockReturnValue(saved.store)
  vi.mocked(runProcess).mockImplementation(async (spec) => {
    const script = (spec.args ?? []).join(' ')
    const begin = /__ORCA_WSL_CAPTURE_BEGIN_[a-z0-9]+__/.exec(script)?.[0]
    const end = /__ORCA_WSL_CAPTURE_END_[a-z0-9]+__/.exec(script)?.[0]
    let stdout: string
    if (begin && end) {
      const probe = script.includes('_orca_env=$(command -v env')
      launches.push(probe ? 'probe' : 'identity')
      const payload = probe
        ? ['/usr/bin:/bin', '/home/u', '/usr/bin/env']
        : ['Ubuntu', String(uid), '/home/u', '/home/u']
      stdout = `banner\n${begin}${payload.join('\0')}${end}`
    } else {
      const args = spec.args ?? []
      const actionIndex = args.findIndex((arg) => arg === 'read' || arg === 'write')
      const action = args[actionIndex]
      if (!action || actionIndex === -1) {
        throw new Error('Unexpected WSL command')
      }
      launches.push(action)
      if (action === 'write') {
        if (typeof spec.input !== 'string') {
          throw new Error('Expected credential input')
        }
        credentialInputs.push(spec.input)
        const [, expected, next] = spec.input.split('\n')
        expect(expected).toBe(Buffer.from(native).toString('base64'))
        native = Buffer.from(next, 'base64').toString('utf8')
      }
      const nonce = args[actionIndex + 4]
      const status = action === 'write' ? 'written' : 'present'
      stdout = `ORCA_AGY_WSL_REPLY_V1 ${nonce}\n${status}\n${Buffer.from(native).toString('base64')}\n`
    }
    return { code: 0, signal: null, stdout, stderr: '', timedOut: false }
  })
  host = await import('./native-account-host')
})
afterEach(() => vi.restoreAllMocks())

it('selects an already-current saved identity without a credential write', async () => {
  native = credential('b', 2)
  const state = await host.runAntigravityAccountOperation(target, 'Select', accountId)
  expect(state.activeAccountId).toBe(accountId)
  expect(state.selectedAccountId).toBe(accountId)
  expect(native).toBe(credential('b', 2))
  expect(saved.getVault().selectedAccountId).toBe(accountId)
  expect(saved.getVault().accounts[0]?.credentials).toBe(credential('b', 2))
  expect(launches).toEqual(['probe', 'identity', 'read', 'read'])
  expect(credentialInputs).toEqual([])
})

it('refuses switching, preserves native and selected accounts, and requires List to restore launch', async () => {
  const current = (await host.runAntigravityAccountOperation(target, 'AddCurrent')).accounts.find(
    (account) => account.id !== accountId
  )
  if (!current) {
    throw new Error('Missing saved current account')
  }
  await host.runAntigravityAccountOperation(target, 'Select', current.id)
  launches = []
  await expect(host.runAntigravityAccountOperation(target, 'Select', accountId)).rejects.toThrow(
    'Sign in with agy on "Ubuntu", then refresh Accounts and save'
  )
  expect(native).toBe(credential('a'))
  expect(saved.getVault().selectedAccountId).toBe(current.id)
  expect(launches).toEqual(['probe', 'identity', 'read'])
  expect(credentialInputs).toEqual([])
  await expect(
    withAntigravityAccountOperation((operation) =>
      host.prepareAntigravityAccountTargetForLaunch(target, operation)
    )
  ).rejects.toThrow('Refresh Accounts')
  await expect(host.runAntigravityAccountOperation(target, 'Select', current.id)).rejects.toThrow(
    'Refresh Accounts'
  )
  const listed = await host.runAntigravityAccountOperation(target, 'List')
  expect(listed.activeAccountId).toBe(current.id)
  expect(listed.selectedAccountId).toBe(current.id)
  const authority = await withAntigravityAccountOperation((operation) =>
    host.prepareAntigravityAccountTargetForLaunch(target, operation)
  )
  expect(authority?.authorityId).toBe(authorityId)
  expect(native).toBe(credential('a'))
  expect(credentialInputs).toEqual([])
})

it('rechecks the authority on the next operation despite an already cached service', async () => {
  native = credential('b')
  await host.runAntigravityAccountOperation(target, 'Select', accountId)
  launches = []
  uid = 1001
  await expect(host.runAntigravityAccountOperation(target, 'Select', accountId)).rejects.toThrow(
    'authority changed'
  )
  expect(launches).toEqual(['probe', 'identity'])
  expect(native).toBe(credential('b'))
  expect(saved.getVault().selectedAccountId).toBe(accountId)
})
