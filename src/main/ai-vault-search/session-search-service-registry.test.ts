import { afterEach, describe, expect, it } from 'vitest'
import { fakeSearchService } from '../../shared/ai-vault/search/ai-vault-search-test-fixture'
import { unavailableSessionSearchStatus } from '../../shared/ai-vault/search/ai-vault-search-client'

import {
  setSessionSearchService,
  sessionSearchServiceStatus
} from './session-search-service-registry'

afterEach(() => {
  setSessionSearchService(null)
})

describe('session search service registry', () => {
  it.each(['ipc', 'relay'] as const)(
    'withholds degraded-root paths from %s status per the exposure policy',
    async (transport) => {
      const service = fakeSearchService()
      service.status.mockResolvedValue({
        ...unavailableSessionSearchStatus(),
        enabled: true,
        phase: 'degraded',
        degradedRoots: [{ root: '/host/projects', reason: 'could not be listed' }]
      })
      setSessionSearchService(service)
      expect((await sessionSearchServiceStatus({}, transport)).degradedRoots).toEqual([
        transport === 'relay'
          ? { reason: 'Source root could not be verified.' }
          : { root: '/host/projects', reason: 'could not be listed' }
      ])
    }
  )
})
