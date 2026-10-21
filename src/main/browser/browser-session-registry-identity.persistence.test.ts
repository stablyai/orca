import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  CLEAN_USER_AGENT,
  createFsState,
  IDENTITY_RECORD_PATH,
  installModuleMocks,
  META_PATH,
  seedMeta
} from './__mocks__/browser-session-registry-persistence-fixture'

describe('BrowserSessionRegistry retired identity data', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.restoreAllMocks()
  })

  // Why: imports before Aug 2026 persisted a synthesized source-browser UA
  // (fork imports as a broken Chrome/1.x, Chrome imports as a valid version).
  // Neither may ever be applied again — the engine-derived UA is the only one.
  it('ignores legacy persisted UAs, valid or broken, and applies the engine UA', async () => {
    const importedPartition = 'persist:orca-browser-session-11111111-1111-4111-8111-111111111111'
    const brokenUa =
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/1.158.1 Safari/537.36'
    const validUa = 'Mozilla/5.0 Chrome/120.0.0.0 Safari/537.36'
    const fsState = createFsState()
    seedMeta(fsState, {
      defaultSource: { browserFamily: 'arc', importedAt: 1 },
      userAgent: brokenUa,
      userAgentByPartition: {
        'persist:orca-browser': brokenUa,
        [importedPartition]: validUa
      },
      pendingCookieDbPath: null,
      pendingCookieImports: {},
      profiles: [
        {
          id: '11111111-1111-4111-8111-111111111111',
          scope: 'imported',
          partition: importedPartition,
          label: 'Imported',
          source: { browserFamily: 'chrome', importedAt: 1 }
        }
      ]
    })

    const { sessionFromPartitionMock, installBrowserSessionUserAgentPolicyMock } =
      installModuleMocks(fsState)
    const { browserSessionRegistry } = await import('./browser-session-registry')

    browserSessionRegistry.initializeBrowserSessionsFromPersistedState()

    const appliedUas = sessionFromPartitionMock.mock.results.flatMap((r) =>
      r.value.setUserAgent.mock.calls.map((c: unknown[]) => c[0])
    )
    expect(appliedUas).not.toContain(brokenUa)
    expect(appliedUas).not.toContain(validUa)
    // Why: every partition inherits the one process identity rather than an imported value.
    expect(appliedUas.length).toBeGreaterThan(0)
    expect(appliedUas.every((ua) => ua === CLEAN_USER_AGENT)).toBe(true)
    expect(installBrowserSessionUserAgentPolicyMock).toHaveBeenCalled()
  })

  it('flags the retired per-profile choice without rewriting its persisted bytes', async () => {
    const importedPartition = 'persist:orca-browser-session-11111111-1111-4111-8111-111111111111'
    const fsState = createFsState()
    seedMeta(fsState, {
      defaultSource: null,
      profiles: [
        {
          id: '11111111-1111-4111-8111-111111111111',
          scope: 'imported',
          partition: importedPartition,
          label: 'Imported',
          source: { browserFamily: 'comet', importedAt: 1 },
          userAgentMode: 'native'
        }
      ]
    })

    installModuleMocks(fsState)
    const { browserSessionRegistry } = await import('./browser-session-registry')

    browserSessionRegistry.initializeBrowserSessionsFromPersistedState()

    await vi.waitFor(() =>
      expect(JSON.parse(fsState.files.get(IDENTITY_RECORD_PATH) ?? '{}')).toEqual({
        version: 1,
        mode: 'clean',
        explicitSelection: false,
        migrationNoticePending: true
      })
    )
    // Retaining the retired key is what makes rollback and data-loss machinery unnecessary.
    expect(JSON.parse(fsState.files.get(META_PATH) ?? '{}').profiles[0].userAgentMode).toBe(
      'native'
    )
  })

  // The notice is documented as one-time, but the legacy bytes it keys on are retained forever by
  // design, so nothing but the explicit choice can stop a later launch from re-arming it.
  it('does not re-arm the retired-choice notice on the launch after an explicit choice', async () => {
    const profileId = '11111111-1111-4111-8111-111111111111'
    const fsState = createFsState()
    seedMeta(fsState, {
      defaultSource: null,
      profiles: [
        {
          id: profileId,
          scope: 'isolated',
          partition: `persist:orca-browser-session-${profileId}`,
          label: 'Existing',
          source: null,
          userAgentMode: 'native'
        }
      ]
    })

    installModuleMocks(fsState)
    const { browserSessionRegistry } = await import('./browser-session-registry')
    const identity = await import('./browser-identity-mode-store')

    browserSessionRegistry.initializeBrowserSessionsFromPersistedState()
    expect(identity.getBrowserIdentityMigrationNotice()).toEqual({ degraded: false })

    await identity.setBrowserIdentityMode('native')
    expect(identity.getBrowserIdentityMigrationNotice()).toBeNull()

    // A fresh launch re-reads the record from disk; the same retired bytes are still beside it.
    identity.resetBrowserIdentityModeStoreForTests()
    browserSessionRegistry.initializeBrowserSessionsFromPersistedState()

    expect(identity.getBrowserIdentityMigrationNotice()).toBeNull()
    expect(JSON.parse(fsState.files.get(IDENTITY_RECORD_PATH) ?? '{}')).toMatchObject({
      explicitSelection: true,
      migrationNoticePending: false
    })
  })

  it.each([
    { scenario: 'malformed members', malformed: [null, 42, 'broken'], failWrite: false },
    { scenario: 'a read-only notice', malformed: [], failWrite: true }
  ])('hydrates the valid profile despite $scenario', async ({ malformed, failWrite }) => {
    const profileId = '11111111-1111-4111-8111-111111111111'
    const partition = `persist:orca-browser-session-${profileId}`
    const fsState = createFsState()
    seedMeta(fsState, {
      defaultSource: null,
      profiles: [
        ...malformed,
        {
          id: profileId,
          scope: 'isolated',
          partition,
          label: 'Existing',
          source: null,
          userAgentMode: 'native'
        }
      ]
    })
    installModuleMocks(fsState, new Set(), failWrite)
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {})
    const { browserSessionRegistry } = await import('./browser-session-registry')

    expect(() => browserSessionRegistry.initializeBrowserSessionsFromPersistedState()).not.toThrow()
    expect(browserSessionRegistry.getProfile(profileId)?.partition).toBe(partition)
    if (failWrite) {
      // Notice bookkeeping may fail; it must report and never gate session startup.
      await vi.waitFor(() => expect(errors).toHaveBeenCalled())
      expect(errors.mock.calls[0]?.[1]).toMatchObject({ message: 'read-only userData' })
    }
    await vi.waitFor(() => expect(fsState.files.has(IDENTITY_RECORD_PATH)).toBe(!failWrite))
    const written = JSON.parse(fsState.files.get(META_PATH) ?? '{}')
    expect(written.profiles).toHaveLength(malformed.length + 1)
    expect(written.profiles.at(-1).userAgentMode).toBe('native')
  })

  it('hydrates a retired native profile under the process identity', async () => {
    const importedPartition = 'persist:orca-browser-session-12121212-1212-4121-8121-121212121212'
    const fsState = createFsState()
    seedMeta(fsState, {
      defaultSource: null,
      userAgent: null,
      userAgentByPartition: {},
      pendingCookieDbPath: null,
      pendingCookieImports: {},
      profiles: [
        {
          id: '12121212-1212-4121-8121-121212121212',
          scope: 'isolated',
          partition: importedPartition,
          label: 'Google',
          source: null,
          userAgentMode: 'native'
        }
      ]
    })

    const { sessionFromPartitionMock, installBrowserSessionUserAgentPolicyMock } =
      installModuleMocks(fsState)
    const { browserSessionRegistry } = await import('./browser-session-registry')

    browserSessionRegistry.initializeBrowserSessionsFromPersistedState()

    const importedSessions = sessionFromPartitionMock.mock.results
      .filter((_, index) => sessionFromPartitionMock.mock.calls[index]?.[0] === importedPartition)
      .map((result) => result.value)
    expect(importedSessions.length).toBeGreaterThan(0)
    expect(
      importedSessions.every((sess) => sess.setUserAgent.mock.calls[0]?.[0] === CLEAN_USER_AGENT)
    ).toBe(true)
    expect(
      installBrowserSessionUserAgentPolicyMock.mock.calls.some(
        ([sess]) => sess.partition === importedPartition
      )
    ).toBe(true)
  })
})
