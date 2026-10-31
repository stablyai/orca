import { afterEach, describe, expect, it } from 'vitest'
import {
  cleanupConnectorHarnesses,
  createConnectorHarness
} from './connector-server-harness.test-fixture.js'
import { loadCheckpoint, saveCheckpoint } from './discord-gateway-checkpoint.js'

afterEach(cleanupConnectorHarnesses)

describe('Discord gateway checkpoint', () => {
  it('resumes where the last commit left off', async () => {
    const { database } = await createConnectorHarness()
    expect(await loadCheckpoint(database)).toBeNull()
    for (const sequence of [4, 5]) {
      const checkpoint = { sessionId: 'session-1', resumeURL: 'wss://gateway.example', sequence }
      await database.transaction((transaction) => saveCheckpoint(transaction, checkpoint))
    }
    expect(await loadCheckpoint(database)).toEqual({
      sessionId: 'session-1',
      resumeURL: 'wss://gateway.example',
      sequence: 5
    })
  })
})
