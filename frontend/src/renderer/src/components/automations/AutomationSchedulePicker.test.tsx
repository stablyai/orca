// @vitest-environment happy-dom
import '@testing-library/jest-dom/vitest'
import React from 'react'
import { render, screen, cleanup, fireEvent } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AutomationSchedulePicker } from './AutomationSchedulePicker'
import type { AutomationDraft } from './AutomationEditorDialog'

// Why: Radix Popover/Select rely on portals and pointer-capture APIs jsdom/
// happy-dom don't implement. Mocking both to always render their content
// (ignoring open state) lets tests interact with the picker's fields
// directly, matching the pattern used by other Select-driven component tests
// in this directory (see ExperimentalPane.test.tsx).
vi.mock('@/components/ui/popover', () => ({
  Popover: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  PopoverContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  PopoverTrigger: ({ children }: { children: React.ReactNode }) => <>{children}</>
}))

vi.mock('@/components/ui/select', async () => {
  const ReactModule = await import('react')
  const SelectContext = ReactModule.createContext<{
    onValueChange?: (value: string) => void
  }>({})

  return {
    Select: ({
      onValueChange,
      children
    }: {
      value: string
      onValueChange: (value: string) => void
      children: React.ReactNode
    }) => {
      const contextValue = ReactModule.useMemo(() => ({ onValueChange }), [onValueChange])
      return (
        <SelectContext.Provider value={contextValue}>
          <div data-slot="select">{children}</div>
        </SelectContext.Provider>
      )
    },
    SelectTrigger: ({ children, ...props }: React.ComponentProps<'button'>) => (
      <button type="button" data-slot="select-trigger" {...props}>
        {children}
      </button>
    ),
    SelectValue: () => null,
    SelectContent: ({ children }: { children: React.ReactNode }) => (
      <div data-slot="select-content">{children}</div>
    ),
    SelectItem: ({ value, children }: { value: string; children: React.ReactNode }) => {
      const { onValueChange } = ReactModule.useContext(SelectContext)
      return (
        <button
          type="button"
          data-slot="select-item"
          data-value={value}
          onClick={() => onValueChange?.(value)}
        >
          {children}
        </button>
      )
    }
  }
})

afterEach(() => {
  cleanup()
})

function makeDraft(overrides: Partial<AutomationDraft> = {}): AutomationDraft {
  return {
    name: 'Nightly audit',
    prompt: 'Audit the repo',
    agentId: 'claude',
    projectId: 'repo-1',
    workspaceMode: 'existing',
    workspaceId: 'wt-1',
    baseBranch: 'main',
    reuseSession: false,
    precheckCommand: '',
    precheckTimeoutSeconds: '60',
    preset: 'daily',
    time: '09:00',
    dayOfWeek: '1',
    customSchedule: '',
    missedRunGraceMinutes: '720',
    scheduleWarning: null,
    ...overrides
  }
}

function renderPicker(draft: AutomationDraft, onDraftChange = vi.fn()): void {
  render(<AutomationSchedulePicker draft={draft} onDraftChange={onDraftChange} />)
}

describe('AutomationSchedulePicker', () => {
  it('shows the Cadence schedule field by default', () => {
    renderPicker(makeDraft())

    expect(screen.getByText('Cadence')).toBeInTheDocument()
    expect(screen.getByText('Time')).toBeInTheDocument()
  })

  it('selecting External hides the cron/schedule input and shows the correct guidance', () => {
    renderPicker(makeDraft())

    // Cadence/time inputs are visible before switching.
    expect(screen.getByText('Cadence')).toBeInTheDocument()
    expect(screen.getByText('Time')).toBeInTheDocument()

    fireEvent.click(screen.getByText('External'))

    // The cron/schedule UI must be gone entirely, not just visually hidden.
    expect(screen.queryByText('Cadence')).not.toBeInTheDocument()
    expect(screen.queryByText('Time')).not.toBeInTheDocument()
    expect(screen.queryByText('Day')).not.toBeInTheDocument()
    expect(screen.queryByText('Minute')).not.toBeInTheDocument()

    // The read-only guidance for calling HandleExternalTrigger takes its place.
    expect(screen.getByText(/HandleExternalTriggerRequest/)).toBeInTheDocument()
    expect(screen.getByText(/automation_id/)).toBeInTheDocument()
    expect(screen.getByText(/request_id/)).toBeInTheDocument()
    expect(screen.getByText(/payload_json/)).toBeInTheDocument()

    // The trigger button's own label reflects the switch too.
    expect(screen.getByText('Triggered externally')).toBeInTheDocument()
  })

  it('switching back to Scheduled restores the Cadence field', () => {
    renderPicker(makeDraft())

    fireEvent.click(screen.getByText('External'))
    expect(screen.queryByText('Cadence')).not.toBeInTheDocument()

    fireEvent.click(screen.getByText('Scheduled'))
    expect(screen.getByText('Cadence')).toBeInTheDocument()
  })

  it('does not mutate the draft when switching trigger mode (no persisted field yet)', () => {
    const onDraftChange = vi.fn()
    renderPicker(makeDraft(), onDraftChange)

    fireEvent.click(screen.getByText('External'))

    expect(onDraftChange).not.toHaveBeenCalled()
  })
})
