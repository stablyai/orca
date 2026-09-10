import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { MaestroHumanReview } from '../../../src/shared/maestro-human-review'
import type { WorkspaceSurfaceSnapshot } from '../../../src/shared/maestro-workspace-canvas'
import { MobileMaestroHumanReview } from './MobileMaestroHumanReview'
import {
  buildMobileReviewBrowserFocusRequest,
  loadMobileMaestroHumanReviews,
  resolveRetainedReviewBrowser,
  type MobileMaestroHumanReviewResource,
  type MobileMaestroReviewAuthority
} from './mobile-maestro-human-review'

vi.mock('react-native', () => ({
  Pressable: 'Pressable',
  StyleSheet: { create: <T,>(styles: T) => styles },
  Text: 'Text',
  TextInput: 'TextInput',
  View: 'View'
}))
vi.mock('expo-crypto', () => ({ randomUUID: () => '00000000-0000-4000-8000-000000000001' }))

const NOW = '2026-08-31T20:00:00.000Z'
const workspace = {
  repository_id: 'repo-1',
  execution_host_id: 'local',
  workspace_key: 'worktree:repo-1::child',
  run_id: 'run-1'
}

function review(overrides: Partial<MaestroHumanReview> = {}): MaestroHumanReview {
  return {
    schema_version: 1,
    protocol: 'maestro-human-review/v1',
    review_id: 'review-1',
    workspace,
    coordinator_generation: 2,
    task_id: 'task-1',
    dispatch_id: 'dispatch-1',
    title: 'Review platform application',
    summary: 'Verify the tailored resume before submission.',
    state: 'needs_input',
    references: {
      documents: [{ document_ref: 'resume.pdf', revision: '7', title: 'Tailored resume' }],
      fields: [{ document_ref: 'application', field_path: 'salary', label: 'Salary answer' }],
      browser: { surface_id: 'surface-1', browser_page_id: 'page-1' }
    },
    decisions: [{ decision_id: 'salary', prompt: 'Confirm the expected salary.' }],
    unresolved_decisions: [{ decision_id: 'salary', prompt: 'Confirm the expected salary.' }],
    staged_receipt: {
      receipt_id: 'stage-1',
      actor: { actor_id: 'coordinator', kind: 'coordinator', authenticated: true },
      state: 'needs_input',
      recorded_at: NOW
    },
    approval_receipt: null,
    submission_receipt: null,
    rejection_receipt: null,
    expiration_receipt: null,
    created_at: NOW,
    updated_at: NOW,
    ...overrides
  }
}

const snapshot = {
  surfaces: {
    browser: {
      id: {
        execution_host_id: 'local',
        workspace_key: workspace.workspace_key,
        unified_tab_id: 'tab-browser'
      },
      title: 'Application portal',
      binding: { kind: 'browser', browser_page_id: 'page-1' }
    }
  }
} as unknown as WorkspaceSurfaceSnapshot

const authority: MobileMaestroReviewAuthority = {
  workspace,
  coordinatorGeneration: 2,
  retainedBrowsers: [{ surfaceId: 'surface-1', browserPageId: 'page-1' }]
}

function resource(overrides: Partial<MobileMaestroHumanReviewResource> = {}) {
  return {
    status: 'ready' as const,
    reviews: [review()],
    message: null,
    refresh: vi.fn(async () => undefined),
    transition: vi.fn(async () => undefined),
    canFocusBrowser: vi.fn(() => true),
    focusBrowser: vi.fn(async () => snapshot.surfaces.browser!),
    ...overrides
  }
}

describe('MobileMaestroHumanReview', () => {
  let renderer: ReactTestRenderer | null = null

  afterEach(() => {
    act(() => renderer?.unmount())
    renderer = null
    vi.clearAllMocks()
  })

  function text(): string[] {
    return renderer!.root
      .findAllByType('Text')
      .map((node) => node.children.filter((child) => typeof child === 'string').join(''))
  }

  it('shows required decisions and keeps technical IDs behind disclosure', () => {
    const reviewResource = resource()
    act(() => {
      renderer = create(
        createElement(MobileMaestroHumanReview, {
          resource: reviewResource,
          snapshot,
          onOpenExactTab: vi.fn()
        })
      )
    })
    const row = renderer!.root
      .findAllByType('Pressable')
      .find((node) => node.props.accessibilityState?.selected === false)!
    act(() => row.props.onPress())

    expect(text()).toEqual(
      expect.arrayContaining([
        'Review platform application',
        'Needs input',
        'Decisions required',
        'Confirm the expected salary.',
        'Browser Focus'
      ])
    )
    expect(text()).not.toContain('dispatch-1')

    act(() =>
      renderer!.root
        .findByProps({ accessibilityLabel: 'Confirm the expected salary.' })
        .props.onChangeText('Use the posted range')
    )
    const approve = renderer!.root
      .findAllByType('Pressable')
      .find((node) =>
        node.findAllByType('Text').some((entry) => entry.children.includes('Approve for submit'))
      )!
    act(() => approve.props.onPress())

    expect(reviewResource.transition).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'approve',
        review_id: 'review-1',
        decision_resolutions: [{ decision_id: 'salary', resolution: 'Use the posted range' }]
      })
    )
  })

  it('renders approval receipts and records submission only from explicit input', () => {
    const approved = review({
      state: 'approved_for_submit',
      decisions: [],
      unresolved_decisions: [],
      approval_receipt: {
        receipt_id: 'approval-1',
        actor: { actor_id: 'human', kind: 'user', authenticated: true, session_id: 'mobile' },
        decision_resolutions: [],
        expires_at: '2026-09-01T20:00:00.000Z',
        recorded_at: NOW
      }
    })
    const reviewResource = resource({ reviews: [approved] })
    act(() => {
      renderer = create(
        createElement(MobileMaestroHumanReview, {
          resource: reviewResource,
          snapshot,
          onOpenExactTab: vi.fn()
        })
      )
    })
    const row = renderer!.root
      .findAllByType('Pressable')
      .find((node) => node.props.accessibilityState?.selected === false)!
    act(() => row.props.onPress())

    expect(text()).toContain('Approved for submit')
    expect(text().some((value) => value.startsWith('Approved until'))).toBe(true)
    const submitInput = renderer!.root.findByProps({
      accessibilityLabel: 'Submission receipt reference'
    })
    act(() => submitInput.props.onChangeText('confirmation-42'))
    const submit = renderer!.root
      .findAllByType('Pressable')
      .find((node) =>
        node.findAllByType('Text').some((entry) => entry.children.includes('Record submission'))
      )!
    act(() => submit.props.onPress())

    expect(reviewResource.transition).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'submit',
        submission_reference: 'confirmation-42'
      })
    )
  })

  it('focuses only the exact retained Browser page and projected tab', async () => {
    expect(resolveRetainedReviewBrowser(review(), authority, snapshot)?.id.unified_tab_id).toBe(
      'tab-browser'
    )
    expect(
      resolveRetainedReviewBrowser(
        review({
          references: {
            ...review().references,
            browser: { surface_id: 'surface-1', browser_page_id: 'other-page' }
          }
        }),
        authority,
        snapshot
      )
    ).toBeNull()
  })

  it('forwards the exact host-issued profile consent when focusing Browser', () => {
    const consent = {
      schema_version: 1 as const,
      protocol: 'maestro-browser-profile-consent/v1' as const,
      consent_id: 'consent-1',
      profile_id: 'profile-1',
      run_id: 'run-1',
      task_id: 'task-1',
      attempt_id: 'dispatch-1',
      granted_by: { actor_id: 'human', kind: 'user' as const, authenticated: true as const },
      granted_at: NOW,
      expires_at: '2026-09-01T20:00:00.000Z',
      revoked_at: null
    }
    const request = buildMobileReviewBrowserFocusRequest(
      review({
        references: {
          ...review().references,
          browser: {
            surface_id: 'surface-1',
            browser_page_id: 'page-1',
            profile_consent_receipt: consent
          }
        }
      }),
      authority
    )

    expect(request).toMatchObject({
      surface_id: 'surface-1',
      profile_consent_receipt: consent
    })
  })

  it('fails closed when a mixed-version host lacks projection authority', async () => {
    const client = {
      sendRequest: vi.fn(async () => ({
        ok: false as const,
        error: { code: 'method_not_found', message: 'Unknown RPC method' }
      }))
    }

    await expect(
      loadMobileMaestroHumanReviews(client as never, {
        execution_host_id: 'local',
        workspace_key: workspace.workspace_key
      })
    ).resolves.toEqual({
      status: 'unavailable',
      message: 'Application review requires a newer Orca host.'
    })
  })
})
