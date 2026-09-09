// @vitest-environment happy-dom
import '@testing-library/jest-dom/vitest'
import { render, screen, cleanup } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AutomationRunHistory } from './AutomationRunHistory'
import type { AutomationRun } from '../../../../shared/automations-types'
import type { Worktree } from '../../../../shared/types'

afterEach(() => {
  cleanup()
})

function makeRun(overrides: Partial<AutomationRun> = {}): AutomationRun {
  return {
    id: 'run-1',
    automationId: 'automation-1',
    title: 'Run 1',
    scheduledFor: Date.now(),
    status: 'completed',
    trigger: 'scheduled',
    workspaceId: null,
    sessionKind: 'terminal',
    chatSessionId: null,
    terminalSessionId: null,
    terminalPaneKey: null,
    terminalPtyId: null,
    outputSnapshot: null,
    precheckResult: null,
    usage: null,
    error: null,
    startedAt: null,
    dispatchedAt: null,
    createdAt: Date.now(),
    ...overrides
  }
}

describe('AutomationRunHistory trigger badge', () => {
  it("displays an 'External' badge for a run created with trigger: 'external'", () => {
    const runs = [makeRun({ id: 'run-external', trigger: 'external' })]

    render(
      <AutomationRunHistory
        runs={runs}
        automationId="automation-1"
        worktreeMap={new Map<string, Worktree>()}
        onOpenRun={vi.fn()}
      />
    )

    expect(screen.getByText('External')).toBeInTheDocument()
  })

  it("still shows 'Scheduled' and 'Manual' badges for the pre-existing trigger values", () => {
    const runs = [
      makeRun({ id: 'run-scheduled', trigger: 'scheduled' }),
      makeRun({ id: 'run-manual', trigger: 'manual' })
    ]

    render(
      <AutomationRunHistory
        runs={runs}
        automationId="automation-1"
        worktreeMap={new Map<string, Worktree>()}
        onOpenRun={vi.fn()}
      />
    )

    expect(screen.getByText('Scheduled')).toBeInTheDocument()
    expect(screen.getByText('Manual')).toBeInTheDocument()
  })
})
