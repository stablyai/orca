import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { OrchestrationDb } from '../../../../orchestration/db/orchestration-db'
import { dispatchStartsChatWorkers } from './dispatch-methods'

describe('dispatchStartsChatWorkers', () => {
  let db: OrchestrationDb

  beforeEach(() => {
    db = new OrchestrationDb(':memory:')
  })

  afterEach(() => db.close())

  it('stamps a dispatch sent directly from a bot home chat', () => {
    const runtime = {
      bots: { list: () => [{ folderWorkspaceId: 'bot-home' }] }
    }
    const caller = {
      sessionId: 'session',
      workspaceId: 'folder:bot-home'
    }

    expect(
      dispatchStartsChatWorkers(
        // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: this helper only reads bots.list for the direct caller path.
        runtime as Parameters<typeof dispatchStartsChatWorkers>[0],
        db,
        undefined,
        // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: this direct caller path reads only session and workspace identity.
        caller as Parameters<typeof dispatchStartsChatWorkers>[3]
      )
    ).toBe(true)
  })

  it('leaves a dispatch from an ordinary chat unchanged', () => {
    const runtime = {
      bots: { list: () => [{ folderWorkspaceId: 'bot-home' }] }
    }
    const caller = {
      sessionId: 'session',
      workspaceId: 'folder:elsewhere'
    }

    expect(
      dispatchStartsChatWorkers(
        // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: this helper only reads bots.list for the direct caller path.
        runtime as Parameters<typeof dispatchStartsChatWorkers>[0],
        db,
        undefined,
        // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: this direct caller path reads only session and workspace identity.
        caller as Parameters<typeof dispatchStartsChatWorkers>[3]
      )
    ).toBe(false)
  })
})
