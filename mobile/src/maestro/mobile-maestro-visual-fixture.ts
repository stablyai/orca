import type { MaestroHumanReview } from '../../../src/shared/maestro-human-review'
import type { MaestroRunProgressV2 } from '../../../src/shared/maestro-run-progress'
import type { WorkspaceSurfaceSnapshot } from '../../../src/shared/maestro-workspace-canvas'
import type { MobileMaestroHumanReviewResource } from './mobile-maestro-human-review'
import type { MobileMaestroRunProgress } from './mobile-maestro-run-progress'

export type MobileMaestroVisualFixtureState = 'staged' | 'needs_input' | 'approved'

// Set only while capturing the repository-owned visual evidence, then restore to null.
export const MOBILE_MAESTRO_VISUAL_FIXTURE_STATE: MobileMaestroVisualFixtureState | null = null

const NOW = '2026-08-31T20:00:00.000Z'

function fixtureReview(state: MobileMaestroVisualFixtureState): MaestroHumanReview {
  const reviewState = state === 'approved' ? 'approved_for_submit' : state
  const decisions =
    state === 'needs_input'
      ? [{ decision_id: 'location', prompt: 'Confirm willingness to relocate to São Paulo.' }]
      : []
  return {
    schema_version: 1,
    protocol: 'maestro-human-review/v1',
    review_id: 'review-career-ops',
    workspace: {
      repository_id: 'resume-helper',
      execution_host_id: 'local',
      workspace_key: 'worktree:resume-helper',
      run_id: 'run-career-ops'
    },
    coordinator_generation: 3,
    task_id: 'tailor-application',
    dispatch_id: 'dispatch-review',
    title: 'Senior Product Engineer application',
    summary: 'Tailored resume and application answers are ready for human review.',
    state: reviewState,
    references: {
      documents: [
        { document_ref: 'resume.pdf', revision: '12', title: 'Tailored resume' },
        { document_ref: 'cover-letter.pdf', revision: '4', title: 'Cover letter' }
      ],
      fields: [
        { document_ref: 'application', field_path: 'salary', label: 'Expected salary' },
        { document_ref: 'application', field_path: 'availability', label: 'Start date' }
      ],
      browser: { surface_id: 'surface-application', browser_page_id: 'page-application' }
    },
    decisions,
    unresolved_decisions: decisions,
    staged_receipt: {
      receipt_id: 'stage-career-ops',
      actor: {
        actor_id: 'coordinator',
        kind: 'coordinator',
        authenticated: true,
        session_id: 'coordinator-session'
      },
      state: state === 'needs_input' ? 'needs_input' : 'staged',
      recorded_at: NOW
    },
    approval_receipt:
      state === 'approved'
        ? {
            receipt_id: 'approval-career-ops',
            actor: {
              actor_id: 'reviewer',
              kind: 'user',
              authenticated: true,
              session_id: 'mobile'
            },
            decision_resolutions: [],
            expires_at: '2026-09-01T20:00:00.000Z',
            recorded_at: NOW
          }
        : null,
    submission_receipt: null,
    rejection_receipt: null,
    expiration_receipt: null,
    created_at: NOW,
    updated_at: NOW
  }
}

function fixtureProgress(): MobileMaestroRunProgress {
  const progress: MaestroRunProgressV2 = {
    schema_version: 2,
    run: { id: 'run-career-ops', title: 'Career Ops · Senior Product Engineer' },
    execution: {
      state: 'completed',
      progress_percent: 100,
      completed: 4,
      total: 4,
      counts: {
        pending: 0,
        running: 0,
        input_required: 0,
        blocked: 0,
        succeeded: 4,
        failed: 0,
        cancelled: 0
      }
    },
    deliverables: { completed: 3, total: 3, progress_percent: 100 },
    operational_reliability: {
      successful: 3,
      failed: 1,
      superseded: 1,
      unverifiable: 0
    },
    projection_health: { state: 'healthy', revision: 12 },
    cleanup_health: { state: 'pending', count: 1 },
    current: [],
    recently_completed: [
      {
        reference: 'resume',
        title: 'Tailored resume',
        purpose: 'deliverable',
        outcome_summary: 'Resume tailored to the role and checked against the source profile.'
      },
      {
        reference: 'browser-retry',
        title: 'Application portal recovery',
        purpose: 'operational',
        operational_outcome: 'superseded',
        successor_reference: 'browser-retry-2',
        outcome_summary: 'A replacement attempt completed the portal review.'
      }
    ],
    next: [],
    blocked: [],
    nested_activity: [],
    technical: {
      execution_host_id: 'local',
      workspace_key: 'worktree:resume-helper',
      run_id: 'run-career-ops',
      revision: 12
    }
  }
  return { schemaVersion: 2, progress }
}

export function buildMobileMaestroVisualFixture(
  state: MobileMaestroVisualFixtureState,
  snapshot: WorkspaceSurfaceSnapshot
): { progress: MobileMaestroRunProgress; resource: MobileMaestroHumanReviewResource } {
  const item = fixtureReview(state)
  return {
    progress: fixtureProgress(),
    resource: {
      status: 'ready',
      reviews: [item],
      message: null,
      refresh: async () => undefined,
      transition: async () => undefined,
      canFocusBrowser: () => state === 'needs_input',
      focusBrowser: async () => {
        const browser = Object.values(snapshot.surfaces).find(
          (surface) => surface.binding.kind === 'browser'
        )
        if (!browser) {
          throw new Error('The exact retained Browser page is unavailable.')
        }
        return browser
      }
    }
  }
}
