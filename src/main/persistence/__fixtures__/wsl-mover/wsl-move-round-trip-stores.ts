/**
 * Real profile stores for a desktop and its WSL host side by side in one test: each binds its own
 * data file at creation, so the shared test directory only has to point at it while it opens.
 */
import { join } from 'node:path'
import type { PersistedState } from '../../../../shared/persisted-state-types'
import {
  createStore,
  readPersistedStateJson,
  testState,
  writeDataFile
} from '../../persistence-test-harness'
import type { Store } from '../../loading-store/store'

export function openWslMoveRoundTripStore(dir: string, seed?: PersistedState): Store {
  testState.dir = dir
  if (seed) {
    writeDataFile(seed)
  }
  return createStore()
}

/** The persisted JSON of the store opened over `dir`, as a reader of its profile gets it. */
export function readWslMoveRoundTripStoreJson(dir: string): string {
  return readPersistedStateJson(join(dir, 'orca-data.json'))
}
