import { beforeEach, describe, expect, it, vi } from 'vitest'
import { join } from 'node:path'

const mocks = vi.hoisted(() => ({
  createAgent: vi.fn(),
  parseKey: vi.fn(),
  readFileSync: vi.fn()
}))

vi.mock('fs', () => ({
  readFileSync: (...args: unknown[]) => mocks.readFileSync(...args)
}))

vi.mock('os', () => ({
  homedir: () => '/home/testuser'
}))

vi.mock('ssh2', () => {
  class MockBaseAgent {}
  return {
    BaseAgent: MockBaseAgent,
    createAgent: (...args: unknown[]) => mocks.createAgent(...args),
    utils: {
      parseKey: (...args: unknown[]) => mocks.parseKey(...args)
    }
  }
})

import { createIdentityFilteredAgent } from './ssh-agent-identity-filter'

const TEST_HOME = '/home/testuser'

function testHomePath(...parts: string[]): string {
  return join(TEST_HOME, ...parts)
}

type TestKey = {
  id: string
  equals: ReturnType<typeof vi.fn>
}

function makeKey(id: string): TestKey {
  return {
    id,
    equals: vi.fn((candidate: unknown) => (candidate as { id?: string }).id === id)
  }
}

describe('createIdentityFilteredAgent', () => {
  beforeEach(() => {
    mocks.createAgent.mockReset()
    mocks.parseKey.mockReset()
    mocks.readFileSync.mockReset()
  })

  it('offers only agent identities matching configured identity files', async () => {
    const allowedKey = makeKey('allowed')
    const otherKey = makeKey('other')
    mocks.readFileSync.mockReturnValue('ssh-ed25519 AAAA allowed')
    mocks.parseKey.mockReturnValue(allowedKey)
    mocks.createAgent.mockReturnValue({
      getIdentities: vi.fn((callback) => callback(undefined, [allowedKey, otherKey])),
      sign: vi.fn()
    })

    const agent = createIdentityFilteredAgent('/tmp/agent.sock', ['~/.ssh/work_key'])
    const identities = await new Promise<unknown[]>((resolve, reject) => {
      agent?.getIdentities((error, keys) => {
        if (error) {
          reject(error)
          return
        }
        resolve(keys ?? [])
      })
    })

    expect(identities).toEqual([allowedKey])
    expect(mocks.readFileSync).toHaveBeenCalledWith(testHomePath('.ssh', 'work_key.pub'))
  })

  it('expands Windows-style configured identity file paths before filtering', async () => {
    const allowedKey = makeKey('allowed')
    mocks.readFileSync.mockReturnValue('ssh-ed25519 AAAA allowed')
    mocks.parseKey.mockReturnValue(allowedKey)
    mocks.createAgent.mockReturnValue({
      getIdentities: vi.fn((callback) => callback(undefined, [allowedKey])),
      sign: vi.fn()
    })

    const agent = createIdentityFilteredAgent('/tmp/agent.sock', ['~\\.ssh\\work_key'])
    const identities = await new Promise<unknown[]>((resolve, reject) => {
      agent?.getIdentities((error, keys) => {
        if (error) {
          reject(error)
          return
        }
        resolve(keys ?? [])
      })
    })

    expect(identities).toEqual([allowedKey])
    expect(mocks.readFileSync).toHaveBeenCalledWith(testHomePath('.ssh', 'work_key.pub'))
  })

  it('filters nested public key entries returned by ssh2 agents', async () => {
    const allowedKey = makeKey('allowed')
    const otherKey = makeKey('other')
    const allowedEntry = { pubKey: { pubKey: allowedKey, comment: 'allowed' } }
    const otherEntry = { pubKey: { pubKey: otherKey, comment: 'other' } }
    mocks.readFileSync.mockReturnValue('ssh-ed25519 AAAA allowed')
    mocks.parseKey.mockReturnValue(allowedKey)
    mocks.createAgent.mockReturnValue({
      getIdentities: vi.fn((callback) => callback(undefined, [allowedEntry, otherEntry])),
      sign: vi.fn()
    })

    const agent = createIdentityFilteredAgent('/tmp/agent.sock', ['/home/testuser/.ssh/work_key'])
    const identities = await new Promise<unknown[]>((resolve, reject) => {
      agent?.getIdentities((error, keys) => {
        if (error) {
          reject(error)
          return
        }
        resolve(keys ?? [])
      })
    })

    expect(identities).toEqual([allowedEntry])
  })

  it('does not create a broad agent when configured identity keys cannot be parsed', () => {
    mocks.readFileSync.mockReturnValue('not-a-key')
    mocks.parseKey.mockReturnValue(new Error('parse failed'))

    expect(createIdentityFilteredAgent('/tmp/agent.sock', ['~/.ssh/work_key'])).toBeUndefined()
    expect(mocks.createAgent).not.toHaveBeenCalled()
  })

  it('delegates signing to the underlying agent', () => {
    const allowedKey = makeKey('allowed')
    const sign = vi.fn()
    const options = { hash: 'sha256' as const }
    const callback = vi.fn()
    mocks.readFileSync.mockReturnValue('ssh-ed25519 AAAA allowed')
    mocks.parseKey.mockReturnValue(allowedKey)
    mocks.createAgent.mockReturnValue({
      getIdentities: vi.fn(),
      sign
    })

    const agent = createIdentityFilteredAgent('/tmp/agent.sock', ['~/.ssh/work_key'])
    const data = Buffer.from('payload')
    agent?.sign(allowedKey as never, data, options, callback)

    expect(sign).toHaveBeenCalledWith(allowedKey, data, options, callback)
  })
})
