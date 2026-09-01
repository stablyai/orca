import { describe, expect, it, vi } from 'vitest'
import { OrcaRuntimeService } from './orca-runtime'
import type { Store } from '../persistence'
import type { GlobalSettings } from '../../shared/types'
import type { RuntimeClientEvent } from '../../shared/runtime-client-events'

type SettingsListener = (updates: Partial<GlobalSettings>, settings: GlobalSettings) => void

describe('runtime agent catalog/reference client events', () => {
  it('emits exactly one client event per revision change', () => {
    let listener: SettingsListener | null = null
    const store = {
      onSettingsChanged: vi.fn((registered: SettingsListener) => {
        listener = registered
        return () => {}
      })
    } as unknown as Store
    const runtime = new OrcaRuntimeService(null, undefined, { agentCatalogStore: store })
    const events: RuntimeClientEvent[] = []
    runtime.onClientEvent((event) => events.push(event))

    expect(listener).not.toBeNull()
    const emit = (updates: Partial<GlobalSettings>): void =>
      listener!(updates, {} as GlobalSettings)

    emit({ agentCatalogRevision: 5 })
    emit({ agentReferenceRevision: 3 })
    // One mutation that advances both revisions (final tombstone prune) emits both.
    emit({ agentCatalogRevision: 6, agentReferenceRevision: 4 })
    // An unrelated settings write emits nothing.
    emit({ workspaceDir: '/tmp' } as Partial<GlobalSettings>)

    expect(events).toEqual([
      { type: 'agentCatalogChanged', revision: 5 },
      { type: 'agentReferencesChanged', revision: 3 },
      { type: 'agentCatalogChanged', revision: 6 },
      { type: 'agentReferencesChanged', revision: 4 }
    ])
  })
})
