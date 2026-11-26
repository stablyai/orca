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
    } as unknown as Parameters<typeof dispatchStartsChatWorkers>[0]
    const caller = {
      sessionId: 'session',
      workspaceId: 'folder:bot-home'
    } as Parameters<typeof dispatchStartsChatWorkers>[3]

    expect(dispatchStartsChatWorkers(runtime, db, undefined, caller)).toBe(true)
  })

  it('leaves a dispatch from an ordinary chat unchanged', () => {
    const runtime = {
      bots: { list: () => [{ folderWorkspaceId: 'bot-home' }] }
    } as unknown as Parameters<typeof dispatchStartsChatWorkers>[0]
    const caller = {
      sessionId: 'session',
      workspaceId: 'folder:elsewhere'
    } as Parameters<typeof dispatchStartsChatWorkers>[3]

    expect(dispatchStartsChatWorkers(runtime, db, undefined, caller)).toBe(false)
  })
})
