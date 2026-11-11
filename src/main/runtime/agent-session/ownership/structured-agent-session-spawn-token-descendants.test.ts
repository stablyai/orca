// Spawn tokens prove descent, including detached editors/dev servers, so never authorize signals alone; scans can still prove an unused reservation.

import { closeTestJournalHostDatabases } from '../../../native-chat/agent-session-journal/store-lifecycle/journal-host-database-test-support'
import type * as NodeFsPromises from 'node:fs/promises'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ORCA_AGENT_SESSION_SPAWN_TOKEN_ENV } from '../../../../shared/agent-session/lifecycle/agent-session-caller-env'
import type { AgentSessionRecordStore } from '../records/agent-session-record-store'
import { openTestAgentSessionRecordStore } from '../records/agent-session-record-store-test-harness'
import type { AgentSessionReserveRequest } from './agent-session-reservation-admission'
import { createStructuredAgentSessionOwnerProbe } from '../structured-agent-session-owner-probe'
import { stopStructuredAgentSessionRuntime } from '../structured-agent-session-runtime'

/** pid -> the NUL-separated environment block `/proc/<pid>/environ` serves. */
const fakeProc = vi.hoisted(() => ({ environs: new Map<number, string>() }))

vi.mock('node:fs/promises', async (importOriginal) => {
  const fsp = await importOriginal<typeof NodeFsPromises>()
  const enoent = (path: string) => Object.assign(new Error(`ENOENT: ${path}`), { code: 'ENOENT' })
  return {
    ...fsp,
    readdir: async (...args: Parameters<typeof fsp.readdir>) =>
      args[0] === '/proc' ? [...fakeProc.environs.keys()].map(String) : fsp.readdir(...args),
    readFile: async (...args: Parameters<typeof fsp.readFile>) => {
      const path = String(args[0])
      if (!path.startsWith('/proc/')) {
        return fsp.readFile(...args)
      }
      const environ = fakeProc.environs.get(Number(path.split('/')[2]))
      if (environ === undefined || !path.endsWith('/environ')) {
        throw enoent(path)
      }
      return environ
    }
  }
})

const HOST_ID = 'local'
const NOW = 1_800_000_000_000
const SESSION = 'session-alpha'
const MINTED_TOKEN = 'spawn-minted-by-this-store'

function environ(token: string | null): string {
  return [
    'PATH=/usr/bin',
    ...(token ? [`${ORCA_AGENT_SESSION_SPAWN_TOKEN_ENV}=${token}`] : [])
  ].join('\0')
}

function reserveRequest(): AgentSessionReserveRequest {
  const operationId = `${NOW}-${'1'.padStart(32, '0')}`
  return {
    sessionId: SESSION,
    location: {
      executionHostId: HOST_ID,
      wslDistro: null,
      workspaceId: 'workspace-1',
      workspaceKind: 'git-worktree'
    },
    provider: 'codex',
    accountHome: { variable: 'CODEX_HOME', path: '/home/dev/.codex' },
    expectedFence: null,
    spawnToken: MINTED_TOKEN,
    claimKeyId: 'key-1',
    handoffOperationId: null,
    probe: { outcome: 'indeterminate', reason: 'no previous owner' },
    operation: { callerKey: 'client-1', operationId, fingerprint: 'fp-1' },
    now: NOW
  }
}

const originalPlatform = process.platform
let stateDirectory: string

beforeEach(async () => {
  stateDirectory = await mkdtemp(join(tmpdir(), 'orca-spawn-token-descendants-'))
  Object.defineProperty(process, 'platform', { configurable: true, value: 'linux' })
})

afterEach(async () => {
  await stopStructuredAgentSessionRuntime()
  Object.defineProperty(process, 'platform', { configurable: true, value: originalPlatform })
  fakeProc.environs.clear()
  vi.restoreAllMocks()
  await closeTestJournalHostDatabases()
  await rm(stateDirectory, { recursive: true, force: true })
})

function openStore(): Promise<AgentSessionRecordStore> {
  return openTestAgentSessionRecordStore(stateDirectory, {
    hostId: HOST_ID
  })
}

describe('the reservation owner probe', () => {
  async function reconcileReservation(): Promise<AgentSessionRecordStore> {
    const crashed = await openStore()
    await crashed.reserveOwner(reserveRequest())
    // The restart after a crash between reservation and recorded identity.
    const store = await openStore()
    await store.reconcileOnRestart({
      probe: createStructuredAgentSessionOwnerProbe(HOST_ID),
      now: NOW
    })
    return store
  }

  it('proves a reservation never spawned when the host scan finds no process carrying its token', async () => {
    fakeProc.environs.set(1, environ(null))
    fakeProc.environs.set(6161, environ('spawn-foreign'))

    const store = await reconcileReservation()

    expect(store.getRecord(SESSION)?.lease).toMatchObject({
      claimStatus: 'released',
      deathEvidence: { kind: 'pid-absent', detail: 'reservation never spawned' }
    })
  })

  it('claims no absence when the host scan finds a process carrying the token', async () => {
    fakeProc.environs.set(5151, environ(MINTED_TOKEN))
    const kill = vi.spyOn(process, 'kill').mockImplementation(() => true)

    const store = await reconcileReservation()

    expect(store.getRecord(SESSION)?.lease).toMatchObject({
      claimStatus: 'released',
      deathEvidence: null
    })
    expect(kill.mock.calls.filter(([, signal]) => signal !== 0)).toEqual([])
  })
})
