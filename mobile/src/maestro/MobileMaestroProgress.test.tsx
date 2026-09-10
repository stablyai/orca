import { createElement } from 'react'
import * as Clipboard from 'expo-clipboard'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type {
  MaestroRunProgress,
  MaestroRunProgressV2
} from '../../../src/shared/maestro-run-progress'
import { MobileMaestroProgress } from './MobileMaestroProgress'
import type { MobileMaestroRunProgress } from './mobile-maestro-run-progress'

vi.mock('react-native', () => ({
  Pressable: 'Pressable',
  ScrollView: 'ScrollView',
  StyleSheet: { create: <T,>(styles: T) => styles },
  Text: 'Text',
  View: 'View'
}))
vi.mock('lucide-react-native', () => ({
  ChevronRight: 'ChevronRight',
  Copy: 'Copy',
  X: 'X'
}))
vi.mock('expo-clipboard', () => ({ setStringAsync: vi.fn().mockResolvedValue(undefined) }))
vi.mock('expo-crypto', () => ({ randomUUID: () => '00000000-0000-4000-8000-000000000001' }))
vi.mock('../components/BottomDrawer', () => ({ BottomDrawer: 'BottomDrawer' }))

const CLEAN_COUNTS = {
  pending: 0,
  running: 0,
  input_required: 0,
  blocked: 0,
  succeeded: 0,
  failed: 0,
  cancelled: 0
} as const

function progressV2(overrides: Partial<MaestroRunProgressV2> = {}): MobileMaestroRunProgress {
  const progress: MaestroRunProgressV2 = {
    schema_version: 2,
    run: { id: 'run-17', title: 'Ship mobile Run progress' },
    execution: {
      state: 'active',
      progress_percent: 33,
      completed: 1,
      total: 3,
      counts: { ...CLEAN_COUNTS, pending: 1, running: 1, succeeded: 1 }
    },
    projection_health: { state: 'healthy', revision: 4 },
    cleanup_health: { state: 'clean', count: 0 },
    current: [
      {
        reference: 'task-current',
        title: 'Render native progress',
        worker_label: 'Mobile UI',
        state: 'running',
        activity_summary: 'Building the phone detail sheet'
      }
    ],
    recently_completed: [
      {
        reference: 'task-complete',
        title: 'Define progress contract',
        worker_label: 'Contracts',
        outcome_summary: 'Published the negotiated v2 schema'
      }
    ],
    next: [
      {
        reference: 'task-next',
        title: 'Capture Android evidence',
        next_step: 'Open the phone and tablet fixtures'
      }
    ],
    blocked: [],
    nested_activity: [
      {
        parent_reference: 'dispatch-parent',
        child_id: 'native-child-1',
        label: 'Accessibility audit',
        model: 'Codex',
        state: 'running',
        activity_summary: 'Reviewing touch targets'
      }
    ],
    technical: {
      execution_host_id: 'host-local',
      workspace_key: 'worktree:mobile',
      run_id: 'run-17',
      revision: 4
    },
    ...overrides
  }
  return { schemaVersion: 2, progress }
}

function legacyProgress(): MobileMaestroRunProgress {
  const progress: MaestroRunProgress = {
    available: true,
    authority: {
      runId: 'run-legacy',
      workspace: { executionHostId: 'host-old', workspaceKey: 'worktree:old' },
      revision: 2
    },
    summary: {
      schema_version: 1,
      state: 'active',
      progress_percent: 25,
      task_counts: {
        approved: 1,
        running: 1,
        input_required: 0,
        blocked: 0,
        pending: 2,
        failed: 0
      },
      current_tasks: [{ task_id: 'raw-current-id', attempt_id: null, status: 'running' }],
      next_tasks: [{ task_id: 'raw-next-id', attempt_id: null, status: 'pending' }],
      cleanup: {
        pending: { count: 0, ids: [], truncated: false },
        unverifiable: { count: 0, ids: [], truncated: false },
        failed: { count: 0, ids: [], truncated: false },
        retained: { count: 0, ids: [], truncated: false }
      },
      last_activity: null,
      blockers: [],
      material_findings: []
    }
  }
  return { schemaVersion: 1, progress }
}

describe('MobileMaestroProgress', () => {
  let renderer: ReactTestRenderer | null = null

  afterEach(() => {
    act(() => renderer?.unmount())
    renderer = null
    vi.clearAllMocks()
  })

  function renderProgress(progress: MobileMaestroRunProgress, wide = true): string[] {
    act(() => {
      renderer = create(createElement(MobileMaestroProgress, { progress, wide }))
    })
    return renderer!.root
      .findAllByType('Text')
      .map((node) => node.children.filter((child) => typeof child === 'string').join(''))
  }

  it('renders human v2 activity and native child ownership on tablets', () => {
    const text = renderProgress(progressV2())

    expect(text).toContain('Ship mobile Run progress')
    expect(text).toContain('33% · 1/3 tasks')
    expect(text).toContain('Render native progress')
    expect(text).toContain('Building the phone detail sheet')
    expect(text).toContain('Published the negotiated v2 schema')
    expect(text).toContain('Open the phone and tablet fixtures')
    expect(text).toContain('Accessibility audit')
    expect(text).toContain('Reviewing touch targets')
  })

  it('keeps completed execution at 100 percent beside a cleanup warning', () => {
    const text = renderProgress(
      progressV2({
        execution: {
          state: 'completed',
          progress_percent: 100,
          completed: 2,
          total: 2,
          counts: { ...CLEAN_COUNTS, succeeded: 2 }
        },
        cleanup_health: {
          state: 'unverifiable',
          count: 1,
          warning: 'Cleanup is unverifiable for 1 worker resource.'
        },
        current: [],
        next: [],
        nested_activity: []
      })
    )

    expect(text).toContain('Completed')
    expect(text).toContain('100% · 2/2 tasks')
    expect(text).toContain('Cleanup health')
    expect(text).toContain('Cleanup is unverifiable for 1 worker resource.')
  })

  it('shows coordinator completion while retaining pending Tasks and health warnings', () => {
    const text = renderProgress(
      progressV2({
        completion: {
          state: 'completed',
          summary: 'Accepted the mobile implementation.',
          evidence: ['Mobile tests passed.'],
          waivers: [{ task_id: 'task-next', reason: 'Deferred with owner approval.' }],
          completed_at: '2026-09-08T12:00:00.000Z',
          completed_by: { handle: 'term_coord', generation: 4 }
        },
        cleanup_health: {
          state: 'unverifiable',
          count: 1,
          warning: 'One terminal remains unverifiable.'
        }
      })
    )

    expect(text).toContain('Completed')
    expect(text).toContain('Run completion')
    expect(text).toContain('Accepted the mobile implementation.')
    expect(text).toContain('Completed by term_coord · coordinator generation 4 · 1 evidence item')
    expect(text).toContain('Mobile tests passed.')
    expect(text).toContain('Deferred with owner approval.')
    expect(text).toContain('One terminal remains unverifiable.')
    expect(text).toContain('33% · 1/3 tasks')
  })

  it('renders blocked reasons without relying on semantic color alone', () => {
    const text = renderProgress(
      progressV2({
        execution: {
          state: 'blocked',
          progress_percent: 0,
          completed: 0,
          total: 1,
          counts: { ...CLEAN_COUNTS, blocked: 1 }
        },
        current: [],
        blocked: [
          {
            reference: 'task-blocked',
            title: 'Capture native evidence',
            worker_label: 'Visual validation',
            blocker_summary: 'Android emulator is unavailable'
          }
        ],
        next: [],
        nested_activity: []
      })
    )

    expect(text).toContain('Blocked')
    expect(text).toContain('Capture native evidence')
    expect(text).toContain('Android emulator is unavailable')
  })

  it('omits percentage for a zero-task Run', () => {
    const text = renderProgress(
      progressV2({
        execution: { state: 'active', completed: 0, total: 0, counts: CLEAN_COUNTS },
        current: [],
        recently_completed: [],
        next: [],
        nested_activity: []
      })
    )

    expect(text).toContain('No tasks')
    expect(text.some((value) => value.includes('%'))).toBe(false)
  })

  it('keeps the v1 fallback bounded and hides raw task IDs from primary content', () => {
    const text = renderProgress(legacyProgress())

    expect(text).toContain('Run progress')
    expect(text).toContain('25% · 1/4 tasks')
    expect(text).toContain('Active task')
    expect(text).toContain('Queued task')
    expect(text).not.toContain('raw-current-id')
    expect(text).not.toContain('raw-next-id')
  })

  it('treats terminal legacy failures as settled without inventing blockers', () => {
    const payload = legacyProgress()
    if (payload.schemaVersion !== 1 || !payload.progress.available) {
      throw new Error('Expected available legacy progress')
    }
    payload.progress.summary = {
      ...payload.progress.summary,
      state: 'partial',
      progress_percent: 60,
      task_counts: {
        approved: 6,
        running: 0,
        input_required: 0,
        blocked: 0,
        pending: 0,
        failed: 4
      },
      current_tasks: [],
      next_tasks: [],
      blockers: Array.from({ length: 4 }, (_, index) => ({
        task_id: `failed-${index}`,
        attempt_id: null,
        finding_ref: null,
        cleanup_id: null
      }))
    }

    const text = renderProgress(payload)

    expect(text).toContain('Completed with failures')
    expect(text).toContain('100% · 10/10 tasks')
    expect(text).not.toContain('Blocked task')
  })

  it('names an unavailable legacy outcome without inventing progress', () => {
    const text = renderProgress({
      schemaVersion: 1,
      progress: { available: false, state: 'outcome_unknown' }
    })

    expect(text).toContain('Run progress unavailable')
    expect(text).toContain('Outcome unknown')
    expect(text).toContain('No current progress is available.')
    expect(text.some((value) => value.includes('%'))).toBe(false)
  })

  it('opens an accessible detail sheet from the compact phone summary', () => {
    renderProgress(progressV2(), false)
    const summary = renderer!.root.findByProps({ testID: 'mobile-maestro-progress' })
    expect(summary.props.accessibilityLabel).toContain('Open Run details')
    expect(renderer!.root.findByType('BottomDrawer').props.visible).toBe(false)

    act(() => summary.props.onPress())

    expect(renderer!.root.findByType('BottomDrawer').props.visible).toBe(true)
  })

  it('keeps the progress surface on the dark Maestro canvas palette', () => {
    renderProgress(progressV2(), false)
    const summary = renderer!.root.findByProps({ testID: 'mobile-maestro-progress' })
    const drawer = renderer!.root.findByType('BottomDrawer')

    expect(summary.props.style).toMatchObject({ backgroundColor: '#1a1a1a' })
    expect(drawer.props.surfaceColor).toBe('#111111')
  })

  it('copies technical identifiers from explicit controls', async () => {
    renderProgress(progressV2())
    const copyRun = renderer!.root.findByProps({ accessibilityLabel: 'Copy Run ID' })

    await act(async () => copyRun.props.onPress())

    expect(Clipboard.setStringAsync).toHaveBeenCalledWith('run-17')
  })
})
