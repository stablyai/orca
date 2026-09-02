import { beforeEach, describe, expect, it, vi } from 'vitest'

const asyncStorageMock = vi.hoisted(() => ({
  getItem: vi.fn(),
  setItem: vi.fn(),
  removeItem: vi.fn()
}))

const secureStoreMock = vi.hoisted(() => ({
  deleteItemAsync: vi.fn(),
  getItemAsync: vi.fn(),
  setItemAsync: vi.fn()
}))
const platformMock = vi.hoisted(() => ({ OS: 'android' }))

vi.mock('@react-native-async-storage/async-storage', () => ({ default: asyncStorageMock }))

vi.mock('expo-secure-store', () => ({
  WHEN_UNLOCKED_THIS_DEVICE_ONLY: 'WHEN_UNLOCKED_THIS_DEVICE_ONLY',
  ...secureStoreMock
}))
vi.mock('react-native', () => ({ Platform: platformMock }))

import {
  deletePairingKeychainItem,
  readPairingKeychainItem,
  resetPairingKeychainForTests,
  writePairingKeychainItem
} from './pairing-keychain'

const GENERATION_KEY = 'orca:pairing-keychain-generation'
const TOKEN_KEY = 'orca.host-token.host-1782629088232'
const TOKEN_PRESENCE_KEY = `orca:pairing-keychain-presence:${TOKEN_KEY}`

// Why: the exact Android failure from #6600 — expo maps a null-message GeneralSecurityException to this.
const ENCRYPT_REJECTION = new Error(
  `Could not encrypt the value for key '${TOKEN_KEY}' under keychain 'key_v1'. Caused by: unknown`
)

type Options = { keychainService?: string } | undefined

function serviceOf(options: Options): string | undefined {
  return options?.keychainService
}

describe('pairing keychain', () => {
  let generationRecord: string | null

  beforeEach(() => {
    vi.clearAllMocks()
    resetPairingKeychainForTests()
    platformMock.OS = 'android'
    generationRecord = null
    asyncStorageMock.getItem.mockImplementation(async (key: string) =>
      key === GENERATION_KEY ? generationRecord : null
    )
    asyncStorageMock.setItem.mockImplementation(async (key: string, raw: string) => {
      if (key === GENERATION_KEY) {
        generationRecord = raw
      }
    })
    secureStoreMock.setItemAsync.mockResolvedValue(undefined)
    secureStoreMock.deleteItemAsync.mockResolvedValue(undefined)
    secureStoreMock.getItemAsync.mockResolvedValue(null)
  })

  it('writes under the default keychain service so existing installs keep their tokens', async () => {
    await writePairingKeychainItem(TOKEN_KEY, 'token')

    expect(secureStoreMock.setItemAsync).toHaveBeenCalledTimes(1)
    const [key, value, options] = secureStoreMock.setItemAsync.mock.calls[0]!
    expect(key).toBe(TOKEN_KEY)
    expect(value).toBe('token')
    // Why: passing any keychainService would change the keystore alias and orphan every already-stored token.
    expect(serviceOf(options as Options)).toBeUndefined()
    expect(generationRecord).toBeNull()
  })

  it('recovers when the reported Android encryption failure is alias-local', async () => {
    // Why: simulate the unverified alias-local case; no affected physical device was available.
    secureStoreMock.setItemAsync.mockImplementation(
      async (_k: string, _v: string, options: Options) => {
        if (serviceOf(options) === undefined) {
          throw ENCRYPT_REJECTION
        }
      }
    )

    await writePairingKeychainItem(TOKEN_KEY, 'token')

    const rotated = secureStoreMock.setItemAsync.mock.calls.at(-1)!
    expect(serviceOf(rotated[2] as Options)).toBe('orca.pairing.v1')
    expect(rotated[1]).toBe('token')
    expect(generationRecord).toBe('1')
  })

  it('surfaces the original error when a rotated write also fails', async () => {
    secureStoreMock.setItemAsync.mockRejectedValue(ENCRYPT_REJECTION)

    await expect(writePairingKeychainItem(TOKEN_KEY, 'token')).rejects.toBe(ENCRYPT_REJECTION)
    expect(generationRecord).toBe('1:pending')
    expect(secureStoreMock.deleteItemAsync).not.toHaveBeenCalled()
  })

  it('retries an unconfirmed alias without consuming another generation', async () => {
    generationRecord = '1:pending'
    secureStoreMock.setItemAsync.mockRejectedValue(ENCRYPT_REJECTION)

    await expect(writePairingKeychainItem(TOKEN_KEY, 'token')).rejects.toBe(ENCRYPT_REJECTION)

    expect(generationRecord).toBe('1:pending')
    expect(secureStoreMock.setItemAsync).toHaveBeenCalledTimes(1)
    expect(serviceOf(secureStoreMock.setItemAsync.mock.calls[0]![2] as Options)).toBe(
      'orca.pairing.v1'
    )
  })

  it('confirms an unconfirmed alias after its first successful write', async () => {
    generationRecord = '1:pending'

    await writePairingKeychainItem(TOKEN_KEY, 'token')

    expect(generationRecord).toBe('1')
    expect(secureStoreMock.setItemAsync).toHaveBeenCalledTimes(1)
    expect(serviceOf(secureStoreMock.setItemAsync.mock.calls[0]![2] as Options)).toBe(
      'orca.pairing.v1'
    )
  })

  it('does not rotate on an iOS keychain failure', async () => {
    platformMock.OS = 'ios'
    secureStoreMock.setItemAsync.mockRejectedValue(ENCRYPT_REJECTION)

    await expect(writePairingKeychainItem(TOKEN_KEY, 'token')).rejects.toBe(ENCRYPT_REJECTION)

    expect(generationRecord).toBeNull()
    expect(secureStoreMock.setItemAsync).toHaveBeenCalledTimes(1)
  })

  it('never stores a token under a generation it could not durably record', async () => {
    // Why: reads only walk back from the recorded generation, so a token written under an
    // unrecorded one is silently unreachable after a relaunch and the host vanishes.
    asyncStorageMock.setItem.mockImplementation(async (key: string) => {
      if (key === GENERATION_KEY) {
        throw new Error('storage full')
      }
    })
    secureStoreMock.setItemAsync.mockImplementation(
      async (_k: string, _v: string, options: Options) => {
        if (serviceOf(options) === undefined) {
          throw ENCRYPT_REJECTION
        }
      }
    )

    await expect(writePairingKeychainItem(TOKEN_KEY, 'token')).rejects.toBe(ENCRYPT_REJECTION)

    const rotatedWrites = secureStoreMock.setItemAsync.mock.calls.filter(
      (call) => serviceOf(call[2] as Options) !== undefined
    )
    expect(rotatedWrites).toHaveLength(0)
    expect(generationRecord).toBeNull()
  })

  it('records the rotation before storing the token so a relaunch can still find it', async () => {
    const order: string[] = []
    asyncStorageMock.setItem.mockImplementation(async (key: string, raw: string) => {
      if (key === GENERATION_KEY) {
        generationRecord = raw
        order.push(`record:${raw}`)
      }
    })
    secureStoreMock.setItemAsync.mockImplementation(
      async (_k: string, _v: string, options: Options) => {
        const service = serviceOf(options)
        if (service === undefined) {
          throw ENCRYPT_REJECTION
        }
        order.push(`store:${service}`)
      }
    )

    await writePairingKeychainItem(TOKEN_KEY, 'token')

    expect(order).toEqual(['record:1:pending', 'store:orca.pairing.v1', 'record:1'])
  })

  it('keeps a successful rotated write reachable when confirmation storage fails', async () => {
    asyncStorageMock.setItem.mockImplementation(async (key: string, raw: string) => {
      if (key !== GENERATION_KEY) {
        return
      }
      if (raw === '1') {
        throw new Error('storage unavailable')
      }
      generationRecord = raw
    })
    secureStoreMock.setItemAsync.mockImplementation(
      async (_k: string, _v: string, options: Options) => {
        if (serviceOf(options) === undefined) {
          throw ENCRYPT_REJECTION
        }
      }
    )

    await expect(writePairingKeychainItem(TOKEN_KEY, 'token')).rejects.toBe(ENCRYPT_REJECTION)

    expect(generationRecord).toBe('1:pending')
    secureStoreMock.getItemAsync.mockImplementation(async (_k: string, options: Options) =>
      serviceOf(options) === 'orca.pairing.v1' ? 'token' : null
    )
    await expect(readPairingKeychainItem(TOKEN_KEY)).resolves.toBe('token')
  })

  it('reads through the rotated service once a rotation has been committed', async () => {
    generationRecord = '1'
    secureStoreMock.getItemAsync.mockImplementation(async (_k: string, options: Options) =>
      serviceOf(options) === 'orca.pairing.v1' ? 'rotated-token' : null
    )

    await expect(readPairingKeychainItem(TOKEN_KEY)).resolves.toBe('rotated-token')
  })

  it('falls back to a retired service so rotation does not orphan a still-readable token', async () => {
    generationRecord = '2'
    secureStoreMock.getItemAsync.mockImplementation(async (_k: string, options: Options) =>
      serviceOf(options) === undefined ? 'legacy-token' : null
    )

    await expect(readPairingKeychainItem(TOKEN_KEY)).resolves.toBe('legacy-token')
    // Why: probes must walk v2 -> v1 -> default rather than stopping at the current generation.
    expect(secureStoreMock.getItemAsync).toHaveBeenCalledTimes(3)
  })

  it('does not return a stale older value when the current alias throws', async () => {
    generationRecord = '1'
    const currentError = new Error('Could not decrypt the value')
    secureStoreMock.getItemAsync.mockImplementation(async (_k: string, options: Options) => {
      if (serviceOf(options) === 'orca.pairing.v1') {
        throw currentError
      }
      return 'legacy-token'
    })

    await expect(readPairingKeychainItem(TOKEN_KEY)).rejects.toBe(currentError)
    expect(secureStoreMock.getItemAsync).toHaveBeenCalledTimes(1)
  })

  it('self-heals to absent, never a stale older value, when a recorded item decrypts as null', async () => {
    generationRecord = '1'
    let presenceRecord: string | null = null
    asyncStorageMock.getItem.mockImplementation(async (key: string) => {
      if (key === GENERATION_KEY) {
        return generationRecord
      }
      return key === TOKEN_PRESENCE_KEY ? presenceRecord : null
    })
    asyncStorageMock.setItem.mockImplementation(async (key: string, raw: string) => {
      if (key === GENERATION_KEY) {
        generationRecord = raw
      }
      if (key === TOKEN_PRESENCE_KEY) {
        presenceRecord = raw
      }
    })
    asyncStorageMock.removeItem.mockImplementation(async (key: string) => {
      if (key === TOKEN_PRESENCE_KEY) {
        presenceRecord = null
      }
    })

    await writePairingKeychainItem(TOKEN_KEY, 'rotated-token')
    expect(presenceRecord).toBe('1')
    expect(asyncStorageMock.setItem.mock.invocationCallOrder[0]).toBeLessThan(
      secureStoreMock.setItemAsync.mock.invocationCallOrder[0]!
    )

    resetPairingKeychainForTests()
    secureStoreMock.getItemAsync.mockImplementation(async (_k: string, options: Options) =>
      serviceOf(options) === undefined ? 'legacy-token' : null
    )

    // Why: Android cannot distinguish absent from undecryptable, and a throw here left every
    // caller's orphan cleanup unreachable; absent is the only self-healing answer.
    await expect(readPairingKeychainItem(TOKEN_KEY)).resolves.toBeNull()
    expect(secureStoreMock.getItemAsync).toHaveBeenCalledTimes(1)

    // Why: clearing the presence record would let the next read walk back to 'legacy-token'.
    expect(presenceRecord).toBe('1')
    await expect(readPairingKeychainItem(TOKEN_KEY)).resolves.toBeNull()
    expect(secureStoreMock.getItemAsync).toHaveBeenCalledTimes(2)
  })

  it('reads an older value while a newly recorded alias has no item yet', async () => {
    generationRecord = '1:pending'
    secureStoreMock.getItemAsync.mockImplementation(async (_k: string, options: Options) =>
      serviceOf(options) === undefined ? 'legacy-token' : null
    )

    await expect(readPairingKeychainItem(TOKEN_KEY)).resolves.toBe('legacy-token')
  })

  it('probes every bounded service when the generation record is temporarily unreadable', async () => {
    asyncStorageMock.getItem.mockImplementation(async (key: string) => {
      if (key === GENERATION_KEY) {
        throw new Error('storage unavailable')
      }
      return null
    })
    secureStoreMock.getItemAsync.mockImplementation(async (_k: string, options: Options) =>
      serviceOf(options) === 'orca.pairing.v2' ? 'rotated-token' : null
    )

    await expect(readPairingKeychainItem(TOKEN_KEY)).resolves.toBe('rotated-token')

    expect(secureStoreMock.getItemAsync).toHaveBeenCalledTimes(7)
  })

  it('does not rotate from a guessed generation when the record is unreadable', async () => {
    const storageError = new Error('storage unavailable')
    asyncStorageMock.getItem.mockRejectedValueOnce(storageError)

    await expect(writePairingKeychainItem(TOKEN_KEY, 'token')).rejects.toBe(storageError)

    expect(asyncStorageMock.setItem).not.toHaveBeenCalled()
    expect(secureStoreMock.setItemAsync).not.toHaveBeenCalled()
  })

  it('deletes the token under every generation so rotation cannot strand a live credential', async () => {
    generationRecord = '2'

    await deletePairingKeychainItem(TOKEN_KEY)

    const services = secureStoreMock.deleteItemAsync.mock.calls.map((call) =>
      serviceOf(call[1] as Options)
    )
    expect(services).toEqual(['orca.pairing.v2', 'orca.pairing.v1', undefined])
    expect(asyncStorageMock.removeItem).toHaveBeenCalledWith(TOKEN_PRESENCE_KEY)
  })

  it('reports a partial delete failure after attempting every generation', async () => {
    generationRecord = '2'
    const deleteError = new Error('delete failed')
    secureStoreMock.deleteItemAsync.mockImplementation(async (_k: string, options: Options) => {
      if (serviceOf(options) === 'orca.pairing.v2') {
        throw deleteError
      }
    })

    await expect(deletePairingKeychainItem(TOKEN_KEY)).rejects.toBe(deleteError)
    expect(secureStoreMock.deleteItemAsync).toHaveBeenCalledTimes(3)
    expect(asyncStorageMock.removeItem).not.toHaveBeenCalled()
  })

  it('serializes writes that share the global generation', async () => {
    let releaseFirst!: () => void
    const firstWrite = new Promise<void>((resolve) => {
      releaseFirst = resolve
    })
    secureStoreMock.setItemAsync.mockImplementationOnce(async () => firstWrite)

    const first = writePairingKeychainItem(TOKEN_KEY, 'first')
    const second = writePairingKeychainItem(`${TOKEN_KEY}.second`, 'second')
    await vi.waitFor(() => expect(secureStoreMock.setItemAsync).toHaveBeenCalledTimes(1))

    releaseFirst()
    await Promise.all([first, second])

    expect(secureStoreMock.setItemAsync).toHaveBeenCalledTimes(2)
  })

  it.each(['not-a-number', '', ' ', '0:pending'])(
    'probes rotated services when generation record %j is malformed',
    async (raw) => {
      generationRecord = raw
      secureStoreMock.getItemAsync.mockImplementation(async (_k: string, options: Options) =>
        serviceOf(options) === 'orca.pairing.v2' ? 'rotated-token' : null
      )

      await expect(readPairingKeychainItem(TOKEN_KEY)).resolves.toBe('rotated-token')
    }
  )

  it.each(['not-a-number', '', ' ', '0:pending'])(
    'refuses to write from malformed generation record %j',
    async (raw) => {
      generationRecord = raw

      await expect(writePairingKeychainItem(TOKEN_KEY, 'token')).rejects.toThrow(
        /generation record is invalid/
      )
      expect(secureStoreMock.setItemAsync).not.toHaveBeenCalled()
    }
  )

  it.each(['not-a-number', '', ' ', '0:pending'])(
    'deletes every bounded service when generation record %j is malformed',
    async (raw) => {
      generationRecord = raw

      await deletePairingKeychainItem(TOKEN_KEY)

      expect(secureStoreMock.deleteItemAsync).toHaveBeenCalledTimes(9)
    }
  )

  it('stops rotating at the generation cap rather than probing unbounded services', async () => {
    generationRecord = '8'
    secureStoreMock.setItemAsync.mockRejectedValue(ENCRYPT_REJECTION)

    await expect(writePairingKeychainItem(TOKEN_KEY, 'token')).rejects.toBe(ENCRYPT_REJECTION)
    expect(secureStoreMock.setItemAsync).toHaveBeenCalledTimes(1)
    expect(generationRecord).toBe('8')
  })
})
