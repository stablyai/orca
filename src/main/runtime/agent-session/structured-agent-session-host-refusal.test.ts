// Journal-open refusal leaves the file intact and other runtime work available.

import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdtemp, readFile, rm, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { isAgentSessionRefusalError } from '../../../shared/agent-session/failures/agent-session-wire-refusals'
import { journalDatabasePath } from '../../native-chat/agent-session-journal/database/journal-host-database'
import { requireStructuredHost } from '../rpc/methods/structured-sessions/creation/structured-agent-session-gate'
import type { RpcContext } from '../rpc/core'
import {
  ensureStructuredAgentSessionHost,
  stopStructuredAgentSessionRuntime
} from './structured-agent-session-runtime'
import { recordingStructuredAgentSessionLogger } from '../../native-chat/agent-session-wire/host/testing/structured-agent-session-logger-test-support'
import { closeTestJournalHostDatabases } from '../../native-chat/agent-session-journal/store-lifecycle/journal-host-database-test-support'

let root: string
let log = recordingStructuredAgentSessionLogger()

// An in-process caller: the same build as the host, so the gate asks it for no capability.
// oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the gate reads only `clientKind` and `clientCapabilities`.
const IN_PROCESS = {} as RpcContext

function install(): ReturnType<typeof ensureStructuredAgentSessionHost> {
  return ensureStructuredAgentSessionHost({
    logger: log.logger,
    stateDirectory: root,
    hostId: 'local',
    claimKeyId: 'key-1',
    resolveWorkspacePath: async () => root,
    resolveEnvironment: async () => ({}),
    resolveLaunchArgs: () => [],
    resolveClaudeAuthPolicy: () => ({ account: 'managed' })
  })
}

/** The refusal as the gate throws it for every structured request. */
function gateRefusal(): { reason: unknown; message: string } {
  try {
    requireStructuredHost(IN_PROCESS)
  } catch (error) {
    if (isAgentSessionRefusalError(error)) {
      return { reason: error.refusal.details?.reason, message: error.refusal.message }
    }
    throw error
  }
  throw new Error('the gate admitted the request')
}

async function digest(path: string): Promise<string> {
  return createHash('sha256')
    .update(await readFile(path))
    .digest('hex')
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'orca-journal-host-refusal-'))
  log = recordingStructuredAgentSessionLogger()
})

afterEach(async () => {
  await stopStructuredAgentSessionRuntime().catch(() => undefined)
  vi.restoreAllMocks()
  await closeTestJournalHostDatabases()
  await rm(root, { recursive: true, force: true })
})

describe('a process whose journal will not open', () => {
  it('refuses every chat and leaves a damaged file exactly as it is', async () => {
    const path = journalDatabasePath(root)
    await writeFile(path, 'not a database '.repeat(512))
    const before = await digest(path)
    vi.spyOn(console, 'warn').mockImplementation(() => undefined)

    await expect(install()).rejects.toMatchObject({
      refusal: { message: 'Unable to load this chat.', details: { reason: 'journalCorrupt' } }
    })
    expect(gateRefusal()).toEqual({
      reason: 'journalCorrupt',
      message: 'Unable to load this chat.'
    })
    expect(await digest(path)).toBe(before)
    expect(existsSync(`${path}-wal`)).toBe(false)
    expect(existsSync(`${path}-shm`)).toBe(false)

    await unlink(path)
    await expect(install()).resolves.toBeDefined()
    expect(gateRefusal).toThrow('the gate admitted the request')
  })
})
