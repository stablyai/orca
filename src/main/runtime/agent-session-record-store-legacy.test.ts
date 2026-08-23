import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  LEGACY_AGENT_SESSION_ID,
  legacyAgentSessionRecordV1,
  legacyDesktopProviderHandleRecordV1,
  legacyMissingAuthorityRecordV1
} from '../../shared/agent-session-record-legacy.test-fixture'
import { AgentSessionRecordStore } from './agent-session-record-store'
import { agentSessionStorePath } from './agent-session-record-store-file'

let directory: string

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'orca-agent-session-legacy-'))
})

afterEach(async () => {
  await rm(directory, { recursive: true, force: true })
})

async function open(): Promise<AgentSessionRecordStore> {
  return AgentSessionRecordStore.open({ directory, hostId: 'local' })
}

async function writeLegacyStore(record: Record<string, unknown>): Promise<void> {
  await writeFile(
    agentSessionStorePath(directory),
    JSON.stringify({
      schemaVersion: 1,
      hostId: 'local',
      records: { [LEGACY_AGENT_SESSION_ID]: record },
      operations: {},
      retiredClaimKeys: []
    })
  )
}

describe('legacy agent session record store', () => {
  it('upgrades a complete v1 identity into durable manual recovery', async () => {
    await writeLegacyStore(legacyAgentSessionRecordV1())

    const reopened = await open()

    const migrated = reopened.getRecord(LEGACY_AGENT_SESSION_ID)
    expect(migrated).toMatchObject({
      schemaVersion: 2,
      lease: {
        claimStatus: 'conflicted',
        handoffStage: 'manual-recovery',
        unreconciled: true
      }
    })
    expect(migrated).not.toHaveProperty('options')
    expect(migrated).not.toHaveProperty('launchEnv')
    const persisted = JSON.parse(await readFile(agentSessionStorePath(directory), 'utf-8'))
    expect(persisted).toMatchObject({
      schemaVersion: 2,
      records: {
        [LEGACY_AGENT_SESSION_ID]: {
          schemaVersion: 2,
          lease: { claimStatus: 'conflicted', handoffStage: 'manual-recovery' }
        }
      },
      unusableRecords: {}
    })
  })

  it.each([
    [
      'desktop id as provider handle',
      legacyDesktopProviderHandleRecordV1,
      'legacy_provider_handle_is_desktop_session'
    ],
    ['missing authority fields', legacyMissingAuthorityRecordV1, 'legacy_shape_invalid']
  ])('durably quarantines v1 rows with %s', async (_name, fixture, reason) => {
    await writeLegacyStore(fixture())

    const reopened = await open()

    expect(reopened.getRecord(LEGACY_AGENT_SESSION_ID)).toBeNull()
    expect(reopened.isSessionUnreadable(LEGACY_AGENT_SESSION_ID)).toBe(true)
    const persisted = JSON.parse(await readFile(agentSessionStorePath(directory), 'utf-8'))
    expect(persisted.records).not.toHaveProperty(LEGACY_AGENT_SESSION_ID)
    expect(persisted.unusableRecords[LEGACY_AGENT_SESSION_ID]).toMatchObject({ reason })
  })

  it('migrates an older store schema while opening it', async () => {
    const filePath = agentSessionStorePath(directory)
    await writeFile(
      filePath,
      JSON.stringify({ schemaVersion: 0, hostId: 'local', records: {}, operations: {} })
    )

    await open()

    const persisted = JSON.parse(await readFile(filePath, 'utf-8'))
    expect(persisted).toMatchObject({ schemaVersion: 2, unusableRecords: {} })
  })
})
