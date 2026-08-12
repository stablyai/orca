import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { performance } from 'node:perf_hooks'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { normalizeFeatureInteractions } from '../shared/feature-interactions'
import type { PersistedState } from '../shared/types'

vi.mock('electron', () => ({
  app: { getPath: () => tmpdir() },
  safeStorage: {
    isEncryptionAvailable: () => false,
    encryptString: (value: string) => Buffer.from(value),
    decryptString: (value: Buffer) => value.toString('utf8')
  }
}))

vi.mock('./telemetry/client', () => ({ track: vi.fn() }))
vi.mock('./telemetry/cohort-classifier', () => ({ getCohortAtEmit: () => ({}) }))

import { Store } from './persistence'

const INTERACTIONS = 200
const tempDirs: string[] = []

function createStore(name: string): { dataFile: string; store: Store } {
  const dir = mkdtempSync(join(tmpdir(), `orca-ui-broadcast-${name}-`))
  tempDirs.push(dir)
  const dataFile = join(dir, 'orca-data.json')
  return { dataFile, store: new Store({ dataFile }) }
}

describe('feature interaction UI broadcast benchmark', () => {
  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('reduces repeated interaction recording to one material UI broadcast', () => {
    const { store: legacyStore } = createStore('legacy')
    const { dataFile, store: optimizedStore } = createStore('optimized')
    let legacyBroadcasts = 0
    let optimizedBroadcasts = 0
    legacyStore.onUIChanged(() => legacyBroadcasts++)
    optimizedStore.onUIChanged(() => optimizedBroadcasts++)

    const legacyStart = performance.now()
    for (let index = 0; index < INTERACTIONS; index++) {
      const featureInteractions = normalizeFeatureInteractions(
        legacyStore.getUI().featureInteractions
      )
      const existing = featureInteractions['agent-orchestration']
      legacyStore.updateUI({
        featureInteractions: {
          ...featureInteractions,
          'agent-orchestration': {
            firstInteractedAt: existing?.firstInteractedAt ?? 1,
            interactionCount: (existing?.interactionCount ?? 0) + 1
          }
        }
      })
    }
    const legacyMs = performance.now() - legacyStart

    const optimizedStart = performance.now()
    for (let index = 0; index < INTERACTIONS; index++) {
      optimizedStore.recordFeatureInteraction('agent-orchestration')
    }
    const optimizedMs = performance.now() - optimizedStart

    expect(legacyBroadcasts).toBe(INTERACTIONS)
    expect(optimizedBroadcasts).toBe(1)
    expect(
      optimizedStore.getUI().featureInteractions?.['agent-orchestration']?.interactionCount
    ).toBe(INTERACTIONS)
    optimizedStore.flush()
    expect(
      new Store({ dataFile }).getUI().featureInteractions?.['agent-orchestration']?.interactionCount
    ).toBe(INTERACTIONS)
    const persisted = JSON.parse(readFileSync(dataFile, 'utf8')) as PersistedState
    expect(persisted.featureInteractionTelemetryBuckets?.['agent-orchestration']).toBe(
      'count_200_499'
    )

    console.log(
      `[bench] ${INTERACTIONS} orchestration interactions: ` +
        `full-state broadcasts ${legacyBroadcasts} -> ${optimizedBroadcasts}; ` +
        `main-thread mutation ${legacyMs.toFixed(2)}ms -> ${optimizedMs.toFixed(2)}ms`
    )
  })
})
