import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { callRuntimeRpc } from './runtime-rpc-client'
import {
  getDefaultDevServerForEnvironment,
  getPreferredAccountsDevServerId,
  setDefaultDevServerForEnvironment,
  setPreferredAccountsDevServerId
} from './accounts-dev-server-connection'

vi.mock('./runtime-rpc-client', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  callRuntimeRpc: vi.fn()
}))

const callRuntimeRpcMock = vi.mocked(callRuntimeRpc)

function createMemoryStorage(): Storage {
  const map = new Map<string, string>()
  return {
    get length() {
      return map.size
    },
    clear: () => map.clear(),
    getItem: (key) => map.get(key) ?? null,
    key: (index) => [...map.keys()][index] ?? null,
    removeItem: (key) => map.delete(key),
    setItem: (key, value) => map.set(key, value)
  }
}

beforeEach(() => {
  vi.stubGlobal('localStorage', createMemoryStorage())
  callRuntimeRpcMock.mockReset()
})

afterEach(() => {
  vi.unstubAllGlobals()
})

// FE-TASK-STORAGE-009
describe('getDefaultDevServerForEnvironment', () => {
  it('returns the localStorage value immediately without calling the RPC map', async () => {
    setPreferredAccountsDevServerId('env-1', 'dev-server-a')

    const result = await getDefaultDevServerForEnvironment('env-1')

    expect(result).toBe('dev-server-a')
    expect(callRuntimeRpcMock).not.toHaveBeenCalled()
  })

  it('falls back to the accountsDevServerMap RPC when localStorage has no entry', async () => {
    callRuntimeRpcMock.mockImplementation((_target, method) => {
      if (method === 'clientState.get') {
        return Promise.resolve({
          found: true,
          stateJson: JSON.stringify({ 'env-2': 'dev-server-b' })
        } as never)
      }
      throw new Error(`unexpected method ${method}`)
    })

    const result = await getDefaultDevServerForEnvironment('env-2')

    expect(result).toBe('dev-server-b')
    expect(callRuntimeRpcMock).toHaveBeenCalledWith(expect.anything(), 'clientState.get', {
      kind: 'accountsDevServerMap'
    })
  })

  it('returns null when neither localStorage nor the RPC map has an entry', async () => {
    callRuntimeRpcMock.mockResolvedValue({ found: false } as never)

    const result = await getDefaultDevServerForEnvironment('env-missing')

    expect(result).toBeNull()
  })
})

describe('setDefaultDevServerForEnvironment', () => {
  it('writes localStorage AND merges into the RPC map without dropping other entries', async () => {
    const written: Record<string, string>[] = []
    callRuntimeRpcMock.mockImplementation((_target, method, params) => {
      if (method === 'clientState.get') {
        return Promise.resolve({
          found: true,
          stateJson: JSON.stringify({ 'env-existing': 'dev-server-existing' })
        } as never)
      }
      if (method === 'clientState.set') {
        const { stateJson } = params as { stateJson: string }
        written.push(JSON.parse(stateJson) as Record<string, string>)
        return Promise.resolve(undefined as never)
      }
      throw new Error(`unexpected method ${method}`)
    })

    await setDefaultDevServerForEnvironment('env-new', 'dev-server-new')

    expect(getPreferredAccountsDevServerId('env-new')).toBe('dev-server-new')
    expect(written).toEqual([
      { 'env-existing': 'dev-server-existing', 'env-new': 'dev-server-new' }
    ])
  })
})
