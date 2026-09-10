import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { MaestroHumanReviewCreateRequest } from '../../../../../shared/maestro-human-review'
import type { MaestroBrowserProfileConsentReceipt } from '../../../../../shared/maestro-browser-surface'
import { OrchestrationDb } from '../orchestration-db'
import {
  createMaestroHumanReview,
  getMaestroHumanReview,
  listMaestroHumanReviews,
  transitionMaestroHumanReview
} from './maestro-human-review-store'

const workspaceBase = {
  repository_id: 'repo-1',
  execution_host_id: 'local',
  workspace_key: 'folder:workspace-1'
}

const worker = {
  actor_id: 'worker-1',
  kind: 'worker' as const,
  authenticated: true as const,
  session_id: 'worker-session-1'
}

const human = {
  actor_id: 'human-1',
  kind: 'user' as const,
  authenticated: true as const,
  session_id: 'human-session-1'
}

describe('Maestro human review store', () => {
  let database: OrchestrationDb
  let taskId: string
  let dispatchId: string
  let workspace: typeof workspaceBase & { run_id: string }
  let browserReference: {
    surface_id: string
    browser_page_id: string
    profile_consent_receipt: MaestroBrowserProfileConsentReceipt
  }

  beforeEach(() => {
    database = new OrchestrationDb(':memory:')
    const run = database.createRun({
      objective: 'Review applications',
      coordinatorHandle: 'coordinator-1',
      coordinatorPaneKey: 'tab_coord:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
    })
    workspace = { ...workspaceBase, run_id: run.id }
    taskId = database.createTask({ spec: 'Prepare application', runId: workspace.run_id }).id
    dispatchId = database.createDispatchContext({
      taskId,
      assigneeHandle: worker.actor_id,
      creator: { kind: 'system' },
      maxDepth: 4
    }).id
    const consent = database.grantMaestroBrowserProfileConsent(
      {
        schema_version: 1,
        protocol: 'maestro-browser-profile-consent/v1',
        workspace,
        profile_id: 'career-profile',
        task_id: taskId,
        attempt_id: dispatchId,
        expires_at: '2099-01-01T00:00:00.000Z'
      },
      human,
      new Date('2026-08-31T11:55:00.000Z')
    )
    const browser = database.reserveMaestroBrowserSurface({
      schema_version: 1,
      protocol: 'maestro-browser-surface/v1',
      request_id: 'review-browser-1',
      workspace,
      actor: worker,
      coordinator_generation: 1,
      task_id: taskId,
      attempt_id: dispatchId,
      agent_id: 'codex',
      url: 'https://example.com/application',
      title: 'Application',
      profile_id: consent.profile_id,
      profile_consent_receipt: consent,
      requested_visibility: 'visible',
      viewport: { width: 1440, height: 900, device_scale_factor: 1 },
      retention: 'retain',
      ownership: 'harness',
      evidence: {
        route_or_component: 'Application',
        state: 'review',
        theme: 'dark',
        source_revision: 'revision-7',
        capture_mode: 'native-viewport'
      }
    }).receipt
    if (!browser.browser_page_id) {
      throw new Error('Reserved review Browser surface has no page identity.')
    }
    browserReference = {
      surface_id: browser.surface_id,
      browser_page_id: browser.browser_page_id,
      profile_consent_receipt: consent
    }
  })

  afterEach(() => database.close())

  function request(reviewId = 'review-1'): MaestroHumanReviewCreateRequest {
    return {
      request_id: `request-${reviewId}`,
      workspace,
      coordinator_generation: 1,
      review_id: reviewId,
      task_id: taskId,
      dispatch_id: dispatchId,
      title: 'Application review',
      summary: 'Review the prepared application before submission.',
      state: 'needs_input',
      references: {
        fields: [{ document_ref: 'document-1', field_path: 'contact.email', label: 'Email' }],
        documents: [{ document_ref: 'document-1', revision: 'revision-7', title: 'Application' }],
        browser: browserReference
      },
      decisions: [{ decision_id: 'email', prompt: 'Confirm the contact email.' }]
    }
  }

  it('persists immutable references and explicit human approval and submission receipts', () => {
    const input = request()
    const created = createMaestroHumanReview(
      database,
      input,
      worker,
      new Date('2026-08-31T12:00:00.000Z')
    )
    input.references.fields[0]!.field_path = 'forged.path'

    const approveRequest = {
      request_id: 'approve-request-1',
      workspace,
      review_id: created.review_id,
      action: 'approve' as const,
      receipt_id: 'approval-1',
      decision_resolutions: [{ decision_id: 'email', resolution: 'Confirmed.' }],
      expires_at: '2026-09-01T12:00:00.000Z'
    }
    const approved = transitionMaestroHumanReview(
      database,
      approveRequest,
      human,
      new Date('2026-08-31T12:05:00.000Z')
    )
    expect(
      transitionMaestroHumanReview(
        database,
        approveRequest,
        human,
        new Date('2026-08-31T12:06:00.000Z')
      )
    ).toEqual(approved)

    const submitRequest = {
      request_id: 'submit-request-1',
      workspace,
      review_id: created.review_id,
      action: 'submit' as const,
      receipt_id: 'submission-1',
      submission_reference: 'confirmation-42'
    }
    const submitted = transitionMaestroHumanReview(
      database,
      submitRequest,
      human,
      new Date('2026-08-31T12:10:00.000Z')
    )
    expect(
      transitionMaestroHumanReview(
        database,
        submitRequest,
        human,
        new Date('2026-08-31T12:11:00.000Z')
      )
    ).toEqual(submitted)
    expect(() =>
      transitionMaestroHumanReview(
        database,
        { ...submitRequest, submission_reference: 'different-confirmation' },
        human
      )
    ).toThrow('reused with different input')

    expect(approved).toMatchObject({ state: 'approved_for_submit', unresolved_decisions: [] })
    expect(submitted).toMatchObject({
      state: 'submitted',
      submission_receipt: { submission_reference: 'confirmation-42', actor: human }
    })
    expect(getMaestroHumanReview(database, created.review_id)?.references.fields[0]).toMatchObject({
      field_path: 'contact.email'
    })
  })

  it('replays one exact rejection and rejects a conflicting retry', () => {
    const created = createMaestroHumanReview(database, request('review-reject'), worker)
    const rejection = {
      request_id: 'reject-request-1',
      workspace,
      review_id: created.review_id,
      action: 'reject' as const,
      receipt_id: 'rejection-1',
      reason: 'Contact details need correction.'
    }
    const rejected = transitionMaestroHumanReview(database, rejection, human)

    expect(transitionMaestroHumanReview(database, rejection, human)).toEqual(rejected)
    expect(() =>
      transitionMaestroHumanReview(database, { ...rejection, reason: 'Different reason.' }, human)
    ).toThrow('reused with different input')
  })

  it('expires approval durably and never treats Browser navigation as submission', () => {
    const created = createMaestroHumanReview(
      database,
      request('review-expiry'),
      worker,
      new Date('2026-08-31T12:00:00.000Z')
    )
    transitionMaestroHumanReview(
      database,
      {
        request_id: 'approve-expiry-request',
        workspace,
        review_id: created.review_id,
        action: 'approve',
        receipt_id: 'approve-expiry',
        decision_resolutions: [{ decision_id: 'email', resolution: 'Confirmed.' }],
        expires_at: '2026-08-31T13:00:00.000Z'
      },
      human,
      new Date('2026-08-31T12:05:00.000Z')
    )

    const [expired] = listMaestroHumanReviews(
      database,
      workspace,
      new Date('2026-08-31T13:01:00.000Z')
    )
    expect(expired).toMatchObject({
      state: 'expired',
      submission_receipt: null,
      expiration_receipt: { expired_at: '2026-08-31T13:00:00.000Z' }
    })
    expect(getMaestroHumanReview(database, created.review_id)?.state).toBe('expired')
  })

  it('rejects incomplete decisions and wrong Task or Dispatch lineage', () => {
    const created = createMaestroHumanReview(database, request(), worker)
    expect(() =>
      transitionMaestroHumanReview(
        database,
        {
          request_id: 'approve-incomplete',
          workspace,
          review_id: created.review_id,
          action: 'approve',
          receipt_id: 'approval-incomplete',
          decision_resolutions: [],
          expires_at: '2099-01-01T00:00:00.000Z'
        },
        human
      )
    ).toThrow('resolve every decision')

    expect(() =>
      createMaestroHumanReview(
        database,
        { ...request('wrong-dispatch'), dispatch_id: 'dispatch-other' },
        worker
      )
    ).toThrow('exact Task and Dispatch')
  })
})
