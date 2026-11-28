import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { AGENT_SESSION_JOURNAL_SCHEMA_VERSION } from '../../shared/agent-session/journal/agent-session-journal-types'
import { AGENT_SESSION_RECORD_SCHEMA_VERSION } from '../../shared/agent-session/lifecycle/agent-session-record'
import { PROTOCOL_VERSION } from '../daemon/protocol/daemon-protocol-version'
import {
  FLOOR_CHECKED_STORES,
  readFloorStoreSchema,
  readStoreSchemaAsOpened,
  type FloorCheckedStore
} from './floor-checked-stores.test-fixture'
import { floorSchemaViolations } from './floor-schema-compatibility.test-fixture'
import { STORE_FLOOR } from './fixtures/store-floor-release'

const dirs: string[] = []
const tempDir = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'store-floor-'))
  dirs.push(dir)
  return dir
}

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true })
  }
})

// The floor refuses a newer profile and opens newer chat stores read-only; it writes a newer orchestration store as is.
const USER_VERSION_MUST_MATCH: Record<FloorCheckedStore, boolean> = {
  profileState: true,
  chatJournal: true,
  chatDomain: true,
  orchestration: false
}

const reviewedTriggers = (store: FloorCheckedStore): Record<string, string> =>
  Object.fromEntries(
    Object.entries(STORE_FLOOR.reviewedFloorTableTriggers)
      .filter(([, trigger]) => trigger.store === store)
      .map(([name, trigger]) => [name, trigger.sql])
  )

describe(`stores stay writable by ${STORE_FLOOR.release}`, () => {
  for (const store of FLOOR_CHECKED_STORES) {
    const floorSchema = STORE_FLOOR.schemas[store]
    const policy = {
      userVersionMustMatch: USER_VERSION_MUST_MATCH[store],
      reviewedFloorTableTriggers: reviewedTriggers(store),
      positionalInsertTables: STORE_FLOOR.positionalInsertTables
    }

    it(`${store}: a new store`, () => {
      const floor = readFloorStoreSchema(tempDir(), floorSchema)
      expect(
        floorSchemaViolations(floor, readStoreSchemaAsOpened(store, tempDir()), policy)
      ).toEqual([])
    })

    it(`${store}: a store the floor build created, after this build opens it`, () => {
      const floor = readFloorStoreSchema(tempDir(), floorSchema)
      const migrated = readStoreSchemaAsOpened(store, tempDir(), floorSchema)
      expect(floorSchemaViolations(floor, migrated, policy)).toEqual([])
    })
  }

  it('keeps chat records readable by the floor build', () => {
    expect(AGENT_SESSION_RECORD_SCHEMA_VERSION).toBe(STORE_FLOOR.agentSessionRecordSchemaVersion)
  })

  it('keeps chat journal rows writable by the floor build', () => {
    expect(AGENT_SESSION_JOURNAL_SCHEMA_VERSION).toBe(STORE_FLOOR.agentSessionJournalSchemaVersion)
  })

  it('never lowers the terminal daemon protocol below the floor', () => {
    expect(PROTOCOL_VERSION).toBeGreaterThanOrEqual(STORE_FLOOR.daemonProtocolVersion)
  })
})
