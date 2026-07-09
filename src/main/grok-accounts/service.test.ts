import { EventEmitter } from 'node:events'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { getDefaultSettings } from '../../shared/constants'
import type { GlobalSettings } from '../../shared/types'

const testState = {
  userDataDir: ''
}

const spawnMock = vi.hoisted(() => vi.fn())

vi.mock('electron', () => ({
  app: {
    getPath: () => testState.userDataDir
  }
}))

vi.mock('node:child_process', () => ({
  spawn: spawnMock
}))

class FakeGrokLoginProcess extends EventEmitter {
  readonly stdout = new PassThrough()
  readonly stderr = new PassThrough()
}

function createStore(settings: GlobalSettings) {
  return {
    getSettings: vi.fn(() => settings),
    updateSettings: vi.fn((updates: Partial<GlobalSettings>) => {
      settings = { ...settings, ...updates }
      return settings
    })
  }
}

function createRateLimits() {
  return {
    refreshGrokForAccountChange: vi.fn().mockResolvedValue(undefined)
  }
}

function grokAuthJson(email: string): string {
  return `${JSON.stringify({
    'https://auth.x.ai::client-id': {
      key: 'access-token',
      refresh_token: 'refresh-token',
      email,
      expires_at: '2099-01-01T00:00:00Z'
    }
  })}\n`
}

function createManagedGrokHome(accountId: string): string {
  const managedHomePath = join(testState.userDataDir, 'grok-accounts', accountId, 'home')
  mkdirSync(managedHomePath, { recursive: true })
  writeFileSync(join(managedHomePath, '.orca-managed-grok-home'), `${accountId}\n`, 'utf-8')
  writeFileSync(join(managedHomePath, 'auth.json'), grokAuthJson(`${accountId}@example.com`), 'utf-8')
  return managedHomePath
}

describe('GrokAccountService', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.clearAllMocks()
    testState.userDataDir = mkdtempSync(join(tmpdir(), 'orca-grok-accounts-'))
  })

  afterEach(() => {
    rmSync(testState.userDataDir, { recursive: true, force: true })
  })

  it('adds a managed account by running grok login inside an isolated GROK_HOME', async () => {
    const settings = {
      ...getDefaultSettings('/tmp/orca-workspaces'),
      grokManagedAccounts: [],
      activeGrokManagedAccountId: null
    }
    const store = createStore(settings)
    const rateLimits = createRateLimits()
    const fakeProcess = new FakeGrokLoginProcess()
    spawnMock.mockImplementation((_command, _args, options: { env?: Record<string, string> }) => {
      const grokHome = options.env?.GROK_HOME
      expect(grokHome).toMatch(/grok-accounts[/\\][^/\\]+[/\\]home$/)
      writeFileSync(join(grokHome!, 'auth.json'), grokAuthJson('grok@example.com'), 'utf-8')
      setImmediate(() => fakeProcess.emit('close', 0))
      return fakeProcess
    })
    const { GrokAccountService } = await import('./service')

    const service = new GrokAccountService(store as never, rateLimits as never)
    const result = await service.addAccount()

    expect(spawnMock).toHaveBeenCalledWith(
      'grok',
      ['login'],
      expect.objectContaining({
        windowsHide: true,
        env: expect.objectContaining({
          GROK_HOME: expect.stringMatching(/grok-accounts[/\\][^/\\]+[/\\]home$/)
        })
      })
    )
    expect(result.accounts).toHaveLength(1)
    expect(result.accounts[0]).toMatchObject({
      email: 'grok@example.com',
      managedHomePath: expect.stringMatching(/grok-accounts[/\\][^/\\]+[/\\]home$/)
    })
    expect(result.activeAccountId).toBe(result.accounts[0]?.id)
    expect(rateLimits.refreshGrokForAccountChange).toHaveBeenCalledTimes(1)
  })

  it('selects and removes managed accounts without touching the system default Grok home', async () => {
    const managedHomePath = createManagedGrokHome('account-1')
    const systemGrokHome = join(testState.userDataDir, '.grok')
    writeFileSync(join(testState.userDataDir, 'system-marker'), 'keep', 'utf-8')
    const settings = {
      ...getDefaultSettings('/tmp/orca-workspaces'),
      grokManagedAccounts: [
        {
          id: 'account-1',
          email: 'one@example.com',
          managedHomePath,
          createdAt: 1,
          updatedAt: 1,
          lastAuthenticatedAt: 1
        }
      ],
      activeGrokManagedAccountId: null
    }
    const store = createStore(settings)
    const rateLimits = createRateLimits()
    const { GrokAccountService } = await import('./service')
    const service = new GrokAccountService(store as never, rateLimits as never)

    const selected = await service.selectAccount('account-1')
    expect(selected.activeAccountId).toBe('account-1')

    const removed = await service.removeAccount('account-1')
    expect(removed.accounts).toEqual([])
    expect(removed.activeAccountId).toBeNull()
    expect(existsSync(managedHomePath)).toBe(false)
    expect(readFileSync(join(testState.userDataDir, 'system-marker'), 'utf-8')).toBe('keep')
    expect(existsSync(systemGrokHome)).toBe(false)
  })

  it('does not return an active managed home when the ownership marker is missing', async () => {
    const managedHomePath = createManagedGrokHome('account-1')
    rmSync(join(managedHomePath, '.orca-managed-grok-home'))
    const settings = {
      ...getDefaultSettings('/tmp/orca-workspaces'),
      grokManagedAccounts: [
        {
          id: 'account-1',
          email: 'one@example.com',
          managedHomePath,
          createdAt: 1,
          updatedAt: 1,
          lastAuthenticatedAt: 1
        }
      ],
      activeGrokManagedAccountId: 'account-1'
    }
    const store = createStore(settings)
    const rateLimits = createRateLimits()
    const { GrokAccountService } = await import('./service')

    const service = new GrokAccountService(store as never, rateLimits as never)

    expect(service.getActiveManagedHomePath()).toBeNull()
  })

  it('does not return an active managed home outside Orca managed storage', async () => {
    const outsideHome = join(testState.userDataDir, 'outside-grok-home')
    mkdirSync(outsideHome, { recursive: true })
    writeFileSync(join(outsideHome, '.orca-managed-grok-home'), 'account-1\n', 'utf-8')
    const settings = {
      ...getDefaultSettings('/tmp/orca-workspaces'),
      grokManagedAccounts: [
        {
          id: 'account-1',
          email: 'one@example.com',
          managedHomePath: outsideHome,
          createdAt: 1,
          updatedAt: 1,
          lastAuthenticatedAt: 1
        }
      ],
      activeGrokManagedAccountId: 'account-1'
    }
    const store = createStore(settings)
    const rateLimits = createRateLimits()
    const { GrokAccountService } = await import('./service')

    const service = new GrokAccountService(store as never, rateLimits as never)

    expect(service.getActiveManagedHomePath()).toBeNull()
  })

  it('recreates a missing managed home before reauthenticating', async () => {
    const managedHomePath = join(testState.userDataDir, 'grok-accounts', 'account-1', 'home')
    const settings = {
      ...getDefaultSettings('/tmp/orca-workspaces'),
      grokManagedAccounts: [
        {
          id: 'account-1',
          email: 'old@example.com',
          managedHomePath,
          createdAt: 1,
          updatedAt: 1,
          lastAuthenticatedAt: 1
        }
      ],
      activeGrokManagedAccountId: 'account-1'
    }
    const store = createStore(settings)
    const rateLimits = createRateLimits()
    const fakeProcess = new FakeGrokLoginProcess()
    spawnMock.mockImplementation((_command, _args, options: { env?: Record<string, string> }) => {
      const grokHome = options.env?.GROK_HOME
      expect(grokHome).toMatch(/grok-accounts[/\\]account-1[/\\]home$/)
      writeFileSync(join(grokHome!, 'auth.json'), grokAuthJson('new@example.com'), 'utf-8')
      setImmediate(() => fakeProcess.emit('close', 0))
      return fakeProcess
    })
    const { GrokAccountService } = await import('./service')

    const service = new GrokAccountService(store as never, rateLimits as never)
    const result = await service.reauthenticateAccount('account-1')

    expect(readFileSync(join(managedHomePath, '.orca-managed-grok-home'), 'utf-8')).toBe(
      'account-1\n'
    )
    expect(result.accounts[0]).toMatchObject({
      id: 'account-1',
      email: 'new@example.com'
    })
  })

  it('repairs the expected managed home marker before reauthenticating', async () => {
    const managedHomePath = join(testState.userDataDir, 'grok-accounts', 'account-1', 'home')
    mkdirSync(managedHomePath, { recursive: true })
    const settings = {
      ...getDefaultSettings('/tmp/orca-workspaces'),
      grokManagedAccounts: [
        {
          id: 'account-1',
          email: 'old@example.com',
          managedHomePath,
          createdAt: 1,
          updatedAt: 1,
          lastAuthenticatedAt: 1
        }
      ],
      activeGrokManagedAccountId: 'account-1'
    }
    const store = createStore(settings)
    const rateLimits = createRateLimits()
    const fakeProcess = new FakeGrokLoginProcess()
    spawnMock.mockImplementation((_command, _args, options: { env?: Record<string, string> }) => {
      writeFileSync(join(options.env!.GROK_HOME!, 'auth.json'), grokAuthJson('fixed@example.com'))
      setImmediate(() => fakeProcess.emit('close', 0))
      return fakeProcess
    })
    const { GrokAccountService } = await import('./service')

    const service = new GrokAccountService(store as never, rateLimits as never)
    const result = await service.reauthenticateAccount('account-1')

    expect(readFileSync(join(managedHomePath, '.orca-managed-grok-home'), 'utf-8')).toBe(
      'account-1\n'
    )
    expect(result.accounts[0]).toMatchObject({ id: 'account-1', email: 'fixed@example.com' })
  })

  it('does not repair an expected managed home that resolves outside managed storage', async () => {
    const managedHomeParent = join(testState.userDataDir, 'grok-accounts', 'account-1')
    const managedHomePath = join(managedHomeParent, 'home')
    const outsideHome = join(testState.userDataDir, 'outside-home')
    mkdirSync(managedHomeParent, { recursive: true })
    mkdirSync(outsideHome, { recursive: true })
    symlinkSync(outsideHome, managedHomePath, process.platform === 'win32' ? 'junction' : 'dir')
    const settings = {
      ...getDefaultSettings('/tmp/orca-workspaces'),
      grokManagedAccounts: [
        {
          id: 'account-1',
          email: 'old@example.com',
          managedHomePath,
          createdAt: 1,
          updatedAt: 1,
          lastAuthenticatedAt: 1
        }
      ],
      activeGrokManagedAccountId: 'account-1'
    }
    const store = createStore(settings)
    const rateLimits = createRateLimits()
    const { GrokAccountService } = await import('./service')

    const service = new GrokAccountService(store as never, rateLimits as never)
    await expect(service.reauthenticateAccount('account-1')).rejects.toThrow(
      'Grok account home is missing or no longer managed by Orca.'
    )

    expect(existsSync(join(outsideHome, '.orca-managed-grok-home'))).toBe(false)
    expect(spawnMock).not.toHaveBeenCalled()
  })
})
