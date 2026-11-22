import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { OrchestrationDb } from '../runtime/orchestration/db/orchestration-db'
import type { OrcaRuntimeService } from '../runtime/orca-runtime'
import { testOrcaSessionId } from '../../shared/agent-session/identity/orca-session-address-test-fixture'
import { closeReplacedBotChat } from './bot-chat-replacement'

const closing = (stopped: boolean) => async () => ({ stopped })

const OLD_CHAT = testOrcaSessionId('11111111-1111-4111-8111-111111111111')

describe("a bot's replaced Chat", () => {
  let db: OrchestrationDb
  let runtime: OrcaRuntimeService

  beforeEach(() => {
    db = new OrchestrationDb(':memory:')
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: closing reads only the db.
    runtime = { getOrchestrationDb: () => db } as unknown as OrcaRuntimeService
  })
  afterEach(() => db.close())

  const coordinatedRun = () =>
    db.createRun({
      objective: 'o',
      coordinatorHandle: null,
      coordinatorPaneKey: null,
      coordinatorOrcaSessionId: OLD_CHAT
    }).id

  it('stops coordinating its Runs once it is proven stopped', async () => {
    const run = coordinatedRun()
    await closeReplacedBotChat(runtime, OLD_CHAT, closing(true))
    expect(db.getRun(run)?.coordinator_orca_session_id).toBeNull()
  })

  it('keeps its Runs when the close cannot be proven, so a retry still finds them', async () => {
    const run = coordinatedRun()
    await closeReplacedBotChat(runtime, OLD_CHAT, closing(false))
    expect(db.getRun(run)?.coordinator_orca_session_id).toBe(OLD_CHAT)
  })
})
