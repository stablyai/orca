import { rmSync } from 'node:fs'

import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  PANE_KEY,
  temporaryDirectories,
  TERMINAL_HANDLE
} from './orchestration-mailbox-notification-test-harness'
import { OrchestrationDb } from './orchestration/db'
import { createRootDispatch } from './orchestration/db/root-dispatch-test-fixture'

describe('Dispatch mailbox Delivery', () => {
  afterEach(() => {
    vi.useRealTimers()
    for (const directory of temporaryDirectories.splice(0)) {
      rmSync(directory, { recursive: true, force: true })
    }
  })

  it('keeps an active worker Delivery stable when the coordinator Run is rebound', () => {
    const db = new OrchestrationDb(':memory:')
    const run = db.createRun({
      objective: 'Rebound coordinator',
      coordinatorHandle: 'term_old_coordinator',
      coordinatorPaneKey: 'tab_old:leaf_old'
    })
    const task = db.createTask({ spec: 'Keep worker mail', runId: run.id })
    const dispatch = createRootDispatch(db, task.id, TERMINAL_HANDLE, PANE_KEY)
    db.insertMessage({
      from: run.coordinator_handle!,
      to: `dispatch:${dispatch.id}`,
      subject: 'Stable guidance',
      runId: run.id
    })
    const delivery = db.getOrCreateMailboxDelivery({
      runId: run.id,
      mailboxHandle: `dispatch:${dispatch.id}`,
      consumerGeneration: 0
    })!

    db.bindRun({
      runId: run.id,
      coordinatorHandle: 'term_new_coordinator',
      coordinatorPaneKey: 'tab_new:leaf_new'
    })

    expect(db.getDeliveryRaw(delivery.delivery.id)?.status).toBe('outstanding')
    expect(
      db.getOrCreateMailboxDelivery({
        runId: run.id,
        mailboxHandle: `dispatch:${dispatch.id}`,
        consumerGeneration: 0
      })?.delivery.id
    ).toBe(delivery.delivery.id)
    db.close()
  })
})
