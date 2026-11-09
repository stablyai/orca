import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  createFsState,
  IDENTITY_RECORD_PATH,
  installModuleMocks,
  seedMeta
} from './browser-session-registry-persistence-test-fixture'

describe('BrowserSessionRegistry retired identity data', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.restoreAllMocks()
  })

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
    const identity = await import('../../identity/mode/browser-identity-mode-store')

    browserSessionRegistry.initializeBrowserSessionsFromPersistedState()
    expect(identity.getBrowserIdentityMigrationNotice()).toEqual({ degraded: false })

    await identity.setBrowserIdentityMode('native')
    expect(identity.getBrowserIdentityMigrationNotice()).toBeNull()

    identity.resetBrowserIdentityModeStoreForTests()
    browserSessionRegistry.initializeBrowserSessionsFromPersistedState()

    expect(identity.getBrowserIdentityMigrationNotice()).toBeNull()
    expect(JSON.parse(fsState.files.get(IDENTITY_RECORD_PATH) ?? '{}')).toMatchObject({
      explicitSelection: true,
      migrationNoticePending: false
    })
  })
})
