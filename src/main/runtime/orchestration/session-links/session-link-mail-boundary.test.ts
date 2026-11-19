import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { OrchestrationDb } from '../db/orchestration-db'
import { SessionLinkParticipant } from '../../../../shared/session-link'
import { testOrcaSessionId } from '../../../../shared/agent-session/identity/orca-session-address-test-fixture'
import { resolveOrchestrationParty } from '../addressing/orchestration-party'
import { SessionLinkStore } from './session-link-store'
import { assertSessionLinkMailBoundary } from './session-link-mail-boundary'
import { inProcessSessionLinks } from './worker/session-link-worker.test-fixture'

vi.mock('../addressing/orchestration-party', () => ({ resolveOrchestrationParty: vi.fn() }))
const sender = testOrcaSessionId('codex-work')
const recipient = testOrcaSessionId('claude-review')

describe('linked peer mail boundary', () => {
  let db: OrchestrationDb
  beforeEach(() => {
    db = new OrchestrationDb(':memory:')
    inProcessSessionLinks(db)
    const participant = (sessionId: string) =>
      SessionLinkParticipant.parse({
        sessionId,
        conversationId: sessionId,
        name: sessionId,
        agent: 'codex',
        role: 'implementer',
        workspaceId: 'workspace',
        directory: '/work',
        branch: '',
        task: '',
        context: ''
      })
    new SessionLinkStore(db).create('pair', 'Review', [participant(sender), participant(recipient)])
    vi.mocked(resolveOrchestrationParty).mockImplementation((address) => ({
      address,
      terminalHandle: address.startsWith('term_') ? address : null,
      paneKey: null,
      orcaSessionId:
        address === 'term_review' || address === `orca_session_id:${recipient}` ? recipient : null
    }))
  })
  afterEach(() => db.close())
  it('rejects direct peer mail on active and paused links, leaving unrelated mail alone', async () => {
    for (const address of ['term_review', `orca_session_id:${recipient}`]) {
      await expect(assertSessionLinkMailBoundary(db, sender, address)).rejects.toThrow('link-send')
    }
    new SessionLinkStore(db).control('pair', 'owner', 'pause', 1, 'pause')
    await expect(assertSessionLinkMailBoundary(db, sender, 'term_review')).rejects.toThrow(
      'link-send'
    )
    await expect(assertSessionLinkMailBoundary(db, sender, 'term_other')).resolves.toBeUndefined()
  })
  it('resolves Run and Dispatch aliases, including older handle-only bindings, before allowing mail', async () => {
    const run = db.createRun({
      objective: 'Review',
      coordinatorHandle: 'term_review',
      coordinatorPaneKey: null
    })
    await expect(assertSessionLinkMailBoundary(db, sender, `run:${run.id}`)).rejects.toThrow(
      'link-send'
    )
    const task = db.createTask({ runId: run.id, spec: 'Review checkpoint' })
    const dispatch = db.createDispatchContext({
      taskId: task.id,
      assigneeHandle: 'term_review',
      creator: { kind: 'system' },
      maxDepth: 5
    })
    await expect(
      assertSessionLinkMailBoundary(db, sender, `dispatch:${dispatch.id}`)
    ).rejects.toThrow('link-send')
    const chatRun = db.createRun({
      objective: 'Chat review',
      coordinatorHandle: null,
      coordinatorPaneKey: null,
      coordinatorOrcaSessionId: recipient
    })
    await expect(assertSessionLinkMailBoundary(db, sender, `run:${chatRun.id}`)).rejects.toThrow(
      'link-send'
    )
  })
})
