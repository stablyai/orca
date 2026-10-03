// The lease reconcile is bookkeeping: a write that fails is reported, and startup and every read
// carry on. Nothing is owed after it, because an unreconciled lease grants no writer and the next
// send reconciles every lease again before it acts. Over records a newer Orca wrote, the reconcile
// adjudicates in memory and writes nothing.

import { cp, readdir, readFile, rm } from 'node:fs/promises'
import { afterEach, expect, it, vi } from 'vitest'
import type * as AgentSessionRecordRows from '../../runtime/agent-session-record-rows'
import {
  openTestAgentSessionRecordStore,
  seedTestAgentSessionStoreFromNewerBuild
} from '../../runtime/agent-session-record-store-test-harness'
import { journalDatabasePath } from '../agent-session-journal/journal-host-database'
import { JOURNAL_NEWER_SCHEMA_MESSAGE } from '../agent-session-journal/journal-open-failure'
import {
  StructuredAgentSessionHost,
  type StructuredAgentSessionHostDeps
} from './structured-agent-session-host'
import {
  adapter,
  attach,
  CALLER,
  envelope,
  hostTestState,
  replaceHostTestState
} from './structured-agent-session-host-test-harness'
import {
  HOST_TEST_NOW as NOW,
  HOST_TEST_SESSION as SESSION,
  hostTestMessage
} from './structured-agent-session-host-test-data'
import { openTestJournalHostDatabase } from '../agent-session-journal/journal-host-database-test-support'

const writes = vi.hoisted(() => ({ failing: false }))

vi.mock('../../runtime/agent-session-record-rows', async (importOriginal) => {
  const actual = await importOriginal<typeof AgentSessionRecordRows>()
  return {
    ...actual,
    writeAgentSessionStoreRows: (...args: Parameters<typeof actual.writeAgentSessionStoreRows>) => {
      if (writes.failing) {
        // What SQLite throws when the disk will not take the commit.
        throw Object.assign(new Error('disk I/O error'), { code: 'ERR_SQLITE_ERROR', errcode: 10 })
      }
      return actual.writeAgentSessionStoreRows(...args)
    }
  }
})

const IO_ERROR = expect.objectContaining({ message: 'disk I/O error' })

const relaunchedRoots: string[] = []

afterEach(async () => {
  writes.failing = false
  await Promise.all(
    relaunchedRoots.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))
  )
})

/** A host with one chat, relaunched over a copy of its files; `newer` marks the copied records as
 *  a newer Orca's. */
async function relaunch(
  newer = false,
  probeOwner: StructuredAgentSessionHostDeps['probeOwner'] = async () => ({
    outcome: 'pid-absent'
  })
) {
  const dying = hostTestState()
  await attach()
  // An empty renewal queues behind every record write, so they are on disk.
  await dying.store.renewLeases([])
  const relaunched = `${dying.root}-relaunched`
  relaunchedRoots.push(relaunched)
  // A dead process holds no lock.
  await cp(dying.root, relaunched, {
    recursive: true,
    filter: (source) => !source.includes('.lock')
  })
  if (newer) {
    await seedTestAgentSessionStoreFromNewerBuild(relaunched)
  }
  const store = await openTestAgentSessionRecordStore(relaunched)
  // The lease-reconcile entries the host logs, by the failure each reports.
  const leaseReconcileLogged = vi.fn()
  const host = new StructuredAgentSessionHost({
    logger: {
      warn: (_message, fields) => {
        if (fields.scope === 'lease-reconcile') {
          leaseReconcileLogged(fields.error)
        }
      },
      error: () => undefined
    },
    store,
    adapter: adapter(),
    journalDatabase: openTestJournalHostDatabase(relaunched),
    claimKeyId: 'key-1',
    mintSpawnToken: () => 'spawn-next',
    probeOwner,
    stopOwnerProcess: () => {
      throw new Error('an owner not proven alive must not be stopped')
    },
    now: () => NOW
  })
  replaceHostTestState({ store, host })
  return { host, store, stateDirectory: relaunched, leaseReconcileLogged }
}

it('reports a startup reconcile whose store write fails, and does not reject', async () => {
  const { host, store, leaseReconcileLogged } = await relaunch()

  writes.failing = true
  await expect(host.reconcileRestartLeases()).resolves.toBeUndefined()

  expect(leaseReconcileLogged).toHaveBeenCalledOnce()
  expect(leaseReconcileLogged).toHaveBeenCalledWith(IO_ERROR)
  // Nothing was adjudicated, so the lease still grants no writer.
  expect(store.getRecord(SESSION)?.lease.unreconciled).toBe(true)
})

it('reconciles the chat on its next send once the store can be written again', async () => {
  const { host, store, leaseReconcileLogged } = await relaunch()
  writes.failing = true
  await host.reconcileRestartLeases()
  expect(leaseReconcileLogged).toHaveBeenCalledOnce()
  writes.failing = false

  const body = hostTestMessage('sent after a startup reconcile failed')
  await expect(
    host.send(CALLER, { envelope: envelope('agentSession.send', { body }), body })
  ).resolves.toMatchObject({ ok: true })

  // The send is queued; delivering it starts the agent, and that start reconciles the lease.
  await vi.waitFor(() => expect(hostTestState().dispatch).toHaveBeenCalledOnce(), {
    timeout: 10_000
  })
  expect(store.getRecord(SESSION)?.lease.unreconciled).toBe(false)
  expect(leaseReconcileLogged).toHaveBeenCalledOnce()
  // Before the relaunched directory is removed, so the child's wind-down can write its lease.
  await host.flushAllStreamedEvents()
})

it('adjudicates records a newer Orca wrote in memory only, and writes nothing', async () => {
  const { host, store, stateDirectory, leaseReconcileLogged } = await relaunch(true)
  expect(store.readOnly).toBe(true)
  const path = journalDatabasePath(stateDirectory)
  const bytes = await readFile(path)
  const files = await readdir(stateDirectory)

  await expect(host.reconcileRestartLeases()).resolves.toBeUndefined()

  expect(leaseReconcileLogged).not.toHaveBeenCalled()
  expect(store.getRecord(SESSION)?.lease).toMatchObject({
    unreconciled: false,
    claimStatus: 'released'
  })
  expect(await readFile(path)).toEqual(bytes)
  expect(await readdir(stateDirectory)).toEqual(files)
})

it('restores a chat for reading while the reconcile keeps failing, and reports it once', async () => {
  const { host, store, leaseReconcileLogged } = await relaunch()
  writes.failing = true
  await host.reconcileRestartLeases()

  await expect(host.restoreReadableSessions([SESSION])).resolves.toBeUndefined()

  expect(host.hasSession(SESSION)).toBe(true)
  expect(store.getRecord(SESSION)?.lease.unreconciled).toBe(true)
  expect(leaseReconcileLogged).toHaveBeenCalledOnce()
  expect(leaseReconcileLogged).toHaveBeenCalledWith(IO_ERROR)
})

it('refuses a send over records a newer Orca wrote with the update words', async () => {
  const { host } = await relaunch(true)
  await host.reconcileRestartLeases()

  const body = hostTestMessage('sent to a chat a newer Orca saved')
  await expect(
    host.send(CALLER, { envelope: envelope('agentSession.send', { body }), body })
  ).resolves.toMatchObject({
    ok: false,
    refusal: {
      code: 'agent_session_journal_unreadable',
      details: { reason: 'journalWrittenByNewerOrca' },
      message: JOURNAL_NEWER_SCHEMA_MESSAGE
    }
  })
})

it('restores a chat for reading from records a newer Orca wrote', async () => {
  const { host, stateDirectory, leaseReconcileLogged } = await relaunch(true)
  const path = journalDatabasePath(stateDirectory)
  const bytes = await readFile(path)

  await expect(host.restoreReadableSessions([SESSION])).resolves.toBeUndefined()

  expect(host.hasSession(SESSION)).toBe(true)
  expect(leaseReconcileLogged).not.toHaveBeenCalled()
  expect(await readFile(path)).toEqual(bytes)
})

// A chat whose owner could not be proven gone is left recovering; the next attach or send retries it.
it('restores a chat for reading when resolving its recovery cannot write the store', async () => {
  const { host, store, leaseReconcileLogged } = await relaunch(false, async () => ({
    outcome: 'indeterminate',
    reason: 'probe'
  }))
  await host.reconcileRestartLeases()
  expect(store.getRecord(SESSION)?.lease.handoffStage).toBe('recovering')
  writes.failing = true

  await expect(host.restoreReadableSessions([SESSION])).resolves.toBeUndefined()

  expect(host.hasSession(SESSION)).toBe(true)
  expect(store.getRecord(SESSION)?.lease.handoffStage).toBe('recovering')
  expect(leaseReconcileLogged).toHaveBeenCalledOnce()
  expect(leaseReconcileLogged).toHaveBeenCalledWith(IO_ERROR)
})

it.each([
  ['startup reconcile', (host: StructuredAgentSessionHost) => host.reconcileRestartLeases()],
  ['read restore', (host: StructuredAgentSessionHost) => host.restoreReadableSessions([SESSION])]
])('keeps the %s resolving when the logger throws', async (_step, read) => {
  const { host, leaseReconcileLogged } = await relaunch()
  const sinkError = new Error('error sink failed')
  leaseReconcileLogged.mockImplementation(() => {
    throw sinkError
  })
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
  writes.failing = true
  try {
    await expect(read(host)).resolves.toBeUndefined()

    expect(leaseReconcileLogged).toHaveBeenCalledOnce()
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('chat lease bookkeeping for a read failed'),
      expect.objectContaining({ error: IO_ERROR, loggerError: sinkError })
    )
  } finally {
    warn.mockRestore()
  }
})
