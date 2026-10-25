import { describe, expect, it, vi } from 'vitest'
import type { CookieClearIdentity } from './browser-cookie-import-clear'
import type { SourcePartitionRead } from './sources/browser-cookie-source-partition'
import { writeImportedCookies, type SourceCookieToWrite } from './browser-cookie-import-write'

const PARTITION_KEY = { topLevelSite: 'https://top.example', hasCrossSiteAncestor: true }

function sourceCookie(
  overrides: Partial<SourceCookieToWrite> & { name: string; partition: SourcePartitionRead }
): SourceCookieToWrite {
  return {
    url: 'https://app.example/',
    value: 'v',
    domain: '.app.example',
    path: '/',
    secure: true,
    httpOnly: false,
    sameSite: 'no_restriction',
    expirationDate: undefined,
    ...overrides
  }
}

function recordingStore() {
  const writeCookieIdentity = vi.fn<(identity: CookieClearIdentity) => Promise<void>>(
    async () => undefined
  )
  return { writeCookieIdentity }
}

const silentOptions = { stopOnFailure: false, log: () => undefined }

describe('writeImportedCookies', () => {
  it('writes a partitioned cookie through the identity store with its partition key intact', async () => {
    const store = recordingStore()

    const phase = await writeImportedCookies(
      store,
      [
        sourceCookie({
          name: 'chips',
          partition: { status: 'partitioned', partitionKey: PARTITION_KEY }
        })
      ],
      silentOptions
    )

    // A swallowed missing-method error must not masquerade as a tested write path.
    expect(store.writeCookieIdentity).toHaveBeenCalledTimes(1)
    expect(store.writeCookieIdentity.mock.calls[0][0]).toMatchObject({
      name: 'chips',
      partitionKey: PARTITION_KEY
    })
    expect(phase.importedCount).toBe(1)
    expect(phase.partitionSkipped).toBe(0)
    expect(phase.writeRejected).toBe(0)
  })

  it('writes an ordinary cookie with no partitionKey attribute at all', async () => {
    const store = recordingStore()

    await writeImportedCookies(
      store,
      [sourceCookie({ name: 'plain', partition: { status: 'unpartitioned' } })],
      silentOptions
    )

    expect(store.writeCookieIdentity).toHaveBeenCalledTimes(1)
    expect(store.writeCookieIdentity.mock.calls[0][0]).not.toHaveProperty('partitionKey')
  })

  it('never writes a cookie whose partition could not be read, and counts it', async () => {
    const store = recordingStore()
    const logged: string[] = []

    const phase = await writeImportedCookies(
      store,
      [
        sourceCookie({ name: 'chips', partition: { status: 'unreadable', reason: 'no ancestor' } }),
        sourceCookie({ name: 'plain', partition: { status: 'unpartitioned' } })
      ],
      { stopOnFailure: false, log: (message) => logged.push(message) }
    )

    expect(store.writeCookieIdentity).toHaveBeenCalledTimes(1)
    expect(store.writeCookieIdentity.mock.calls[0][0].name).toBe('plain')
    expect(phase.partitionSkipped).toBe(1)
    expect(phase.importedCount).toBe(1)
    expect(phase.failure).toBeNull()
    expect(logged.join('\n')).toContain('unreadable partition')
  })

  it('logs only the domain for a skipped cookie, never its name or value', async () => {
    const logged: string[] = []

    await writeImportedCookies(
      recordingStore(),
      [
        sourceCookie({
          name: 'session-token',
          value: 'super-secret',
          partition: { status: 'unreadable', reason: 'no ancestor' }
        })
      ],
      { stopOnFailure: false, log: (message) => logged.push(message) }
    )

    const line = logged.join('\n')
    expect(line).toContain('app.example')
    expect(line).not.toContain('super-secret')
    expect(line).not.toContain('session-token')
  })

  it('writes __Host- cookies host-only at the root path so Chromium accepts them', async () => {
    const store = recordingStore()

    await writeImportedCookies(
      store,
      [
        sourceCookie({
          name: '__Host-session',
          path: '/deep',
          partition: { status: 'partitioned', partitionKey: PARTITION_KEY }
        })
      ],
      silentOptions
    )

    expect(store.writeCookieIdentity.mock.calls[0][0]).toMatchObject({
      hostOnly: true,
      path: '/',
      partitionKey: PARTITION_KEY
    })
  })

  it('stops at the first rejection when the caller must roll back', async () => {
    const store = recordingStore()
    store.writeCookieIdentity.mockRejectedValueOnce(new Error('rejected'))

    const phase = await writeImportedCookies(
      store,
      [
        sourceCookie({ name: 'first', partition: { status: 'unpartitioned' } }),
        sourceCookie({ name: 'second', partition: { status: 'unpartitioned' } })
      ],
      { stopOnFailure: true, log: () => undefined }
    )

    expect(store.writeCookieIdentity).toHaveBeenCalledTimes(1)
    expect(phase.writeRejected).toBe(1)
    expect(phase.importedCount).toBe(0)
    expect(phase.failure).toBeInstanceOf(Error)
  })

  it('keeps going past a rejection when the caller has a restart fallback', async () => {
    const store = recordingStore()
    store.writeCookieIdentity.mockRejectedValueOnce(new Error('rejected'))

    const phase = await writeImportedCookies(
      store,
      [
        sourceCookie({ name: 'first', partition: { status: 'unpartitioned' } }),
        sourceCookie({ name: 'second', partition: { status: 'unpartitioned' } })
      ],
      silentOptions
    )

    expect(store.writeCookieIdentity).toHaveBeenCalledTimes(2)
    expect(phase.writeRejected).toBe(1)
    expect(phase.importedCount).toBe(1)
  })

  it('reports the removal key at the identity path so a rollback can undo the write', async () => {
    const phase = await writeImportedCookies(
      recordingStore(),
      [
        sourceCookie({
          name: 'scoped',
          url: 'https://app.example/',
          path: '/settings',
          partition: { status: 'unpartitioned' }
        })
      ],
      silentOptions
    )

    expect(phase.attemptedKeys).toEqual([{ url: 'https://app.example/settings', name: 'scoped' }])
  })
})
