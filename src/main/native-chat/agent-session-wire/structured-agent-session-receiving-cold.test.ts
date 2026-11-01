import { describe, expect, it, vi } from 'vitest'
import { acquiredAgentSessionAccount } from '../../../shared/agent-session-acquired-account'
import { readJournalSessionEpoch } from '../agent-session-journal/journal-row-table'
import {
  createReceivingCallerFixture,
  HOME_A,
  HOME_B,
  PARENT
} from './structured-agent-session-receiving-callers.test-support'

describe('registered ensure constructs from cold conversation-owned evidence', () => {
  it('opens existing native state and journal before reservation, then proves the actual A recipe', async () => {
    const f = await createReceivingCallerFixture()
    try {
      await f.found()
      const original = acquiredAgentSessionAccount(f.rig.store.requireWritableRecord(PARENT))
      expect(original?.recipe.home).toBe(HOME_A.path)
      await f.coldNative()
      expect(f.runtime.getOrchestrationDbIfAvailable()).toBeNull()
      f.selectB()
      const adopts = vi.spyOn(f.rig.host.collaboratorsForTests().sessions, 'set')
      const acquire = f.rig.adapter.acquire
      acquire.mockClear()
      expect(await f.ensure()).toMatchObject({ ok: true })
      expect(acquire).toHaveBeenCalledTimes(1)
      expect(acquire.mock.calls[0]?.[0].accountRecipe).toEqual(original?.recipe)
      expect(
        acquiredAgentSessionAccount(f.rig.store.requireWritableRecord(PARENT))?.recipe
      ).toEqual(original?.recipe)
      expect(f.runtime.getOrchestrationDbIfAvailable()).not.toBeNull()
      expect(f.rig.host.childAccountHome(PARENT)).toEqual(HOME_A)
      expect(adopts).toHaveBeenCalledTimes(1)
    } finally {
      await f.dispose()
    }
  })

  it('a last-success receipt alone does not pin an eligible ordinary acquisition', async () => {
    const f = await createReceivingCallerFixture()
    try {
      await f.found()
      await f.rig.host.close(PARENT, 'evict')
      f.selectB()
      f.rig.adapter.acquire.mockClear()
      expect(await f.ensure()).toMatchObject({ ok: true })
      expect(f.rig.adapter.acquire.mock.calls[0]?.[0].accountRecipe).toBeUndefined()
      expect(f.rig.host.childAccountHome(PARENT)).toEqual(HOME_B)
      expect(
        acquiredAgentSessionAccount(f.rig.store.requireWritableRecord(PARENT))?.recipe.home
      ).toBe(HOME_B.path)
    } finally {
      await f.dispose()
    }
  })

  it.each([true, false])(
    'absent journal keeps native evidence, reportsRecipe=%s',
    async (reportsRecipe) => {
      const f = await createReceivingCallerFixture({ reportsRecipe })
      try {
        await f.proveWithoutJournal()
        expect(readJournalSessionEpoch(f.rig.host.deps.journalDatabase.db, PARENT)).toBeNull()
        await f.coldNative()
        f.selectB()
        f.rig.adapter.acquire.mockClear()
        expect(await f.ensure()).toMatchObject({ ok: true })
        expect(f.rig.host.childAccountHome(PARENT)).toEqual(reportsRecipe ? HOME_A : HOME_B)
        expect(f.rig.adapter.acquire.mock.calls[0]?.[0].accountRecipe?.home).toBe(
          reportsRecipe ? HOME_A.path : undefined
        )
      } finally {
        await f.dispose()
      }
    }
  )

  it('an actually unreadable native DB fails the operation without constructing or overwriting A', async () => {
    const f = await createReceivingCallerFixture()
    try {
      await f.found()
      await f.coldNative()
      f.selectB()
      const record = f.rig.store.requireWritableRecord(PARENT)
      const db = f.runtime.getExistingOrchestrationDb()
      if (!db) {
        throw new Error('persisted database missing')
      }
      const prepare = db.db.prepare.bind(db.db)
      const read = vi.spyOn(db.db, 'prepare').mockImplementation((sql) => {
        if (sql.includes('SELECT id FROM runs WHERE coordinator_orca_session_id')) {
          throw new Error('fixture native read unavailable')
        }
        return prepare(sql)
      })
      f.rig.adapter.acquire.mockClear()
      expect(await f.ensure()).toEqual({
        ok: false,
        refusal: {
          code: 'agent_session_operation_invalid',
          details: { ownerVerdict: 'exited' },
          ownerVerdict: 'exited',
          message: "Claude couldn't restart. Send your message to try again."
        }
      })
      read.mockRestore()
      expect(f.rig.adapter.acquire).not.toHaveBeenCalled()
      const after = f.rig.store.requireWritableRecord(PARENT)
      expect(after.lease.claimStatus).toBe('released')
      expect(acquiredAgentSessionAccount(after)?.recipe).toEqual(
        acquiredAgentSessionAccount(record)?.recipe
      )
      expect(await f.ensure()).toMatchObject({ ok: true })
      expect(f.rig.host.childAccountHome(PARENT)).toEqual(HOME_A)
    } finally {
      await f.dispose()
    }
  })

  it('direct cancellation during selected resolution starts nothing and preserves last success', async () => {
    const f = await createReceivingCallerFixture()
    try {
      await f.found()
      await f.rig.host.close(PARENT, 'evict')
      const receipt = acquiredAgentSessionAccount(f.rig.store.requireWritableRecord(PARENT))
      let release: (() => void) | undefined
      const waiting = new Promise<void>((resolve) => {
        release = resolve
      })
      const resolveAccount = vi
        .spyOn(f.rig.host.deps, 'launchAccountHome')
        .mockImplementation(async () => {
          await waiting
          return HOME_B
        })
      f.rig.adapter.acquire.mockClear()
      const result = f.ensure().then(
        (value) => ({ value }),
        (error: unknown) => ({ error })
      )
      await vi.waitFor(() => expect(resolveAccount).toHaveBeenCalled())
      f.rig.host
        .collaboratorsForTests()
        .runtimeState.acquireAborts.abort(PARENT, 'stopped while starting')
      release?.()
      await result
      expect(f.rig.adapter.acquire).not.toHaveBeenCalled()
      expect(
        acquiredAgentSessionAccount(f.rig.store.requireWritableRecord(PARENT))?.recipe
      ).toEqual(receipt?.recipe)
      expect(f.rig.store.requireWritableRecord(PARENT).lease.claimStatus).toBe('released')
      expect(readJournalSessionEpoch(f.rig.host.deps.journalDatabase.db, PARENT)).not.toBeNull()
    } finally {
      await f.dispose()
    }
  })
})
