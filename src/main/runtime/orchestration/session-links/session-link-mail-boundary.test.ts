import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { OrchestrationDb } from '../db'
import { SessionLinkParticipant } from '../../../../shared/session-link'
import { testOrcaSessionId } from '../../../../shared/orca-session-address-test-fixture'
import { resolveOrchestrationParty } from '../orchestration-party'
import { SessionLinkStore } from './session-link-store'
import { assertSessionLinkMailBoundary } from './session-link-mail-boundary'

vi.mock('../orchestration-party', () => ({ resolveOrchestrationParty: vi.fn() }))
const sender = testOrcaSessionId('codex-work')
const recipient = testOrcaSessionId('claude-review')

describe('linked peer mail boundary', () => {
  let db: OrchestrationDb
  beforeEach(() => {
    db = new OrchestrationDb(':memory:')
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
  it('rejects direct peer mail on active and paused links, leaving unrelated mail alone', () => {
    for (const address of ['term_review', `orca_session_id:${recipient}`]) {
      expect(() => assertSessionLinkMailBoundary(db, sender, address)).toThrow('link-send')
    }
    new SessionLinkStore(db).control('pair', 'owner', 'pause', 1, 'pause')
    expect(() => assertSessionLinkMailBoundary(db, sender, 'term_review')).toThrow('link-send')
    expect(() => assertSessionLinkMailBoundary(db, sender, 'term_other')).not.toThrow()
  })
  it('resolves Run and Dispatch aliases, including older handle-only bindings, before allowing mail', () => {
    const run = db.createRun({
      objective: 'Review',
      coordinatorHandle: 'term_review',
      coordinatorPaneKey: null
    })
    expect(() => assertSessionLinkMailBoundary(db, sender, `run:${run.id}`)).toThrow('link-send')
    const task = db.createTask({ runId: run.id, spec: 'Review checkpoint' })
    const dispatch = db.createDispatchContext({
      taskId: task.id,
      assigneeHandle: 'term_review',
      creator: { kind: 'system' },
      maxDepth: 5
    })
    expect(() => assertSessionLinkMailBoundary(db, sender, `dispatch:${dispatch.id}`)).toThrow(
      'link-send'
    )
    const chatRun = db.createRun({
      objective: 'Chat review',
      coordinatorHandle: null,
      coordinatorPaneKey: null,
      coordinatorOrcaSessionId: recipient
    })
    expect(() => assertSessionLinkMailBoundary(db, sender, `run:${chatRun.id}`)).toThrow(
      'link-send'
    )
  })
})
