/**
 * The record store opened on its own, for launch admission, and the chat host built on it later.
 * The store is a single writer, so the property that matters is that there is only ever one.
 */

import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { JournalHostDatabase } from '../native-chat/agent-session-journal/journal-host-database'
import { createStructuredAgentSessionLogger } from '../native-chat/agent-session-wire/structured-agent-session-logger'
import { openAgentSessionRecordStoreOnce } from './agent-session-record-store-slot'
import {
  ensureStructuredAgentSessionHost,
  stopStructuredAgentSessionRuntime
} from './structured-agent-session-runtime'

const HOST_ID = 'local'
let stateDirectory: string

function location(directory = stateDirectory) {
  return {
    stateDirectory: directory,
    hostId: HOST_ID,
    logger: createStructuredAgentSessionLogger()
  }
}

beforeEach(async () => {
  stateDirectory = await mkdtemp(join(tmpdir(), 'orca-record-store-slot-'))
})

afterEach(async () => {
  await stopStructuredAgentSessionRuntime()
  vi.restoreAllMocks()
  await rm(stateDirectory, { recursive: true, force: true })
})

describe('the record store slot', () => {
  it('hands every caller the same store', async () => {
    const [first, second] = await Promise.all([
      openAgentSessionRecordStoreOnce(location()),
      openAgentSessionRecordStoreOnce(location())
    ])

    expect(second.store).toBe(first.store)
  })

  it('builds a chat host installed after admission on the store admission opened', async () => {
    const { store } = await openAgentSessionRecordStoreOnce(location())
    const close = vi.spyOn(JournalHostDatabase.prototype, 'close')

    const host = await ensureStructuredAgentSessionHost({
      ...location(),
      claimKeyId: 'key-1',
      resolveWorkspacePath: async () => stateDirectory,
      resolveClaudeAuthPolicy: () => ({ stripAuthEnv: true }),
      resolveEnvironment: async () => ({}),
      resolveLaunchArgs: () => []
    })
    expect(host.deps.store).toBe(store)

    await stopStructuredAgentSessionRuntime()
    // The host's teardown closes the one connection; stop does not close it a second time.
    expect(close).toHaveBeenCalledOnce()
  })

  it('closes a store no chat host was built on when the runtime stops', async () => {
    const { store } = await openAgentSessionRecordStoreOnce(location())
    const close = vi.spyOn(JournalHostDatabase.prototype, 'close')

    await stopStructuredAgentSessionRuntime()

    expect(close).toHaveBeenCalledOnce()
    const reopened = await openAgentSessionRecordStoreOnce(location())
    expect(reopened.store).not.toBe(store)
  })

  it('refuses a second profile rather than opening a second store', async () => {
    await openAgentSessionRecordStoreOnce(location())
    const elsewhere = await mkdtemp(join(tmpdir(), 'orca-record-store-slot-other-'))
    try {
      await expect(openAgentSessionRecordStoreOnce(location(elsewhere))).rejects.toThrow(
        'agent_session_record_store_location_changed'
      )
    } finally {
      await rm(elsewhere, { recursive: true, force: true })
    }
  })

  it('lets the next caller retry after an open fails', async () => {
    const notADirectory = join(stateDirectory, 'profile-file')
    await writeFile(notADirectory, 'not a profile')

    await expect(openAgentSessionRecordStoreOnce(location(notADirectory))).rejects.toThrow()
    await expect(openAgentSessionRecordStoreOnce(location())).resolves.toMatchObject({
      store: expect.anything()
    })
  })
})
