// The spawn token is an environment variable, so every descendant of a provider child inherits it:
// an editor the agent opened with `code .`, a tmux server, a detached dev server. Carrying the token
// proves descent, not being the provider child, so the host never signals a process on the token
// alone. The token scan still answers one question soundly: whether a reservation ever spawned.

import type * as NodeFsPromises from 'node:fs/promises'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { CODEX_SPAWN_TOKEN_ENV } from '../codex/codex-structured-owner-identity'
import type { AgentSessionRecordStore } from './agent-session-record-store'
import { openTestAgentSessionRecordStore } from './agent-session-record-store-test-harness'
import type { AgentSessionReserveRequest } from './agent-session-reservation-admission'
import { createStructuredAgentSessionOwnerProbe } from './structured-agent-session-owner-probe'
import {
  ensureStructuredAgentSessionHost,
  stopStructuredAgentSessionRuntime
} from './structured-agent-session-runtime'
import { createStructuredAgentSessionLogger } from '../native-chat/agent-session-wire/structured-agent-session-logger'
import { codexProviderHandle } from '../../shared/agent-session-provider-handle-encoding'

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
  return ['PATH=/usr/bin', ...(token ? [`${CODEX_SPAWN_TOKEN_ENV}=${token}`] : [])].join('\0')
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
  await rm(stateDirectory, { recursive: true, force: true })
})

function openStore(): Promise<AgentSessionRecordStore> {
  return openTestAgentSessionRecordStore(stateDirectory, {
    hostId: HOST_ID
  })
}

describe('a process that inherited a spawn token', () => {
  it('is never signalled when the host installs and reconciles, even when this store minted the token', async () => {
    // A chat ran and ended: its root exited and the lease was released, clearing the token.
    const seed = await openStore()
    const reserved = await seed.reserveOwner(reserveRequest())
    const fence = reserved.record.lease.runtimeFence
    await seed.commitProcessIdentity({
      sessionId: SESSION,
      fence,
      process: { hostId: HOST_ID, pid: 4242, processStartTimeMs: NOW, spawnToken: MINTED_TOKEN },
      now: NOW
    })
    await seed.proveOwner({
      sessionId: SESSION,
      fence,
      link: {
        linkId: 'link-1',
        handle: codexProviderHandle('thread-1'),
        origin: 'created',
        mintedAtFence: fence,
        observedAt: NOW
      },
      now: NOW
    })
    const released = await seed.evictProvenDeadOwner({
      sessionId: SESSION,
      expectedFence: fence,
      probe: { outcome: 'pid-absent' },
      now: NOW
    })
    expect(released.lease).toMatchObject({ claimStatus: 'released', reservedSpawnToken: null })

    // The editor the agent opened detached into its own group and outlived the chat, still
    // carrying the token; another descendant carries a token no store here ever minted.
    fakeProc.environs.set(1, environ(null))
    fakeProc.environs.set(5151, environ(MINTED_TOKEN))
    fakeProc.environs.set(6161, environ('spawn-foreign'))
    const kill = vi.spyOn(process, 'kill').mockImplementation(() => true)

    const host = await ensureStructuredAgentSessionHost({
      logger: createStructuredAgentSessionLogger(),
      stateDirectory,
      hostId: HOST_ID,
      claimKeyId: 'key-1',
      resolveWorkspacePath: async () => stateDirectory,
      resolveLaunchArgs: () => [],
      resolveClaudeAuthPolicy: () => ({ account: 'managed' }),
      resolveEnvironment: async () => ({})
    })
    // The installed host reads the record the seed wrote, so the check below has a lease to act on.
    expect(host.deps.store.getRecord(SESSION)?.lease.claimStatus).toBe('released')
    await host.reconcileRestartLeases()
    // Install work that is not awaited would have run by now; nothing here waits on a timer.
    await new Promise((resolve) => setTimeout(resolve, 50))

    expect(kill.mock.calls.filter(([, signal]) => signal !== 0)).toEqual([])
  })
})

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

    // Released without evidence, and the process carrying the token is left alone.
    expect(store.getRecord(SESSION)?.lease).toMatchObject({
      claimStatus: 'released',
      deathEvidence: null
    })
    expect(kill.mock.calls.filter(([, signal]) => signal !== 0)).toEqual([])
  })
})
