// @vitest-environment happy-dom

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { useState } from 'react'
import { cleanup, render, screen } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import { afterEach, describe, expect, it } from 'vitest'
import type { TopLevelView } from '../../../shared/ui-chrome-types'
import { Dialog, DialogContent, DialogTitle } from '../components/ui/dialog'
import {
  type TaskPageOverlayFlagSetters,
  useDismissTaskPageOverlaysWhenHidden
} from '../components/use-dismiss-task-page-overlays'
import { useAppStore } from '../store'
import { renderTasksView } from './app-workspace-shell-tasks-view'

const WORKSPACE_SHELL_PATH = join(process.cwd(), 'src/renderer/src/app-shell/AppWorkspaceShell.tsx')
const TASKS_VIEW_PATH = join(
  process.cwd(),
  'src/renderer/src/app-shell/app-workspace-shell-tasks-view.tsx'
)

let taskPageMountCount = 0

function noopOverlaySetters(
  overrides: Partial<TaskPageOverlayFlagSetters> = {}
): TaskPageOverlayFlagSetters {
  return {
    setNewIssueOpen: () => {},
    setNewLinearIssueOpen: () => {},
    setNewLinearProjectOpen: () => {},
    setNewJiraIssueOpen: () => {},
    setNewJiraIssueProjectComboboxOpen: () => {},
    setLinearConnectOpen: () => {},
    setJiraConnectOpen: () => {},
    ...overrides
  }
}

function TasksPageDouble(): React.JSX.Element {
  const [generation] = useState(() => {
    taskPageMountCount += 1
    return taskPageMountCount
  })
  return <h1 data-testid="tasks-page-heading">Tasks {generation}</h1>
}

function TasksComposerPage(): React.JSX.Element {
  const [open, setOpen] = useState(true)
  const [title] = useState('keep this draft')
  useDismissTaskPageOverlaysWhenHidden(noopOverlaySetters({ setNewIssueOpen: setOpen }))
  return (
    <>
      <span data-testid="composer-draft">{title}</span>
      <span data-testid="composer-open">{open ? 'open' : 'closed'}</span>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent aria-describedby={undefined}>
          <DialogTitle>New GitHub issue</DialogTitle>
        </DialogContent>
      </Dialog>
    </>
  )
}

function TasksSelectedSheetPage(): React.JSX.Element {
  const [open] = useState(true)
  const [selectedRow] = useState('ORC-21')
  return (
    <>
      <span data-testid="selected-row">{selectedRow}</span>
      <span data-testid="sheet-open">{open ? 'open' : 'closed'}</span>
      <Dialog open={open}>
        <DialogContent aria-describedby={undefined}>
          <DialogTitle>Issue sheet</DialogTitle>
        </DialogContent>
      </Dialog>
    </>
  )
}

function TasksHost({
  activeView,
  page
}: {
  activeView: TopLevelView
  page?: React.ReactNode
}): React.JSX.Element {
  return <>{renderTasksView(activeView, page ?? <TasksPageDouble />)}</>
}

afterEach(() => {
  cleanup()
  taskPageMountCount = 0
})

describe('renderTasksView', () => {
  it('keeps the Tasks page mounted and hidden when leaving the view', () => {
    const view = render(<TasksHost activeView="tasks" />)
    const heading = screen.getByTestId('tasks-page-heading')
    const wrapper = view.container.querySelector('[data-app-workspace-shell-tasks-view]')
    if (!(wrapper instanceof HTMLElement)) {
      throw new Error('tasks view wrapper not rendered')
    }

    expect(heading).toBeVisible()
    expect(wrapper.hidden).toBe(false)
    expect(wrapper).not.toHaveAttribute('aria-hidden', 'true')
    expect(taskPageMountCount).toBe(1)

    view.rerender(<TasksHost activeView="terminal" />)

    expect(screen.getByTestId('tasks-page-heading')).toBe(heading)
    expect(heading).not.toBeVisible()
    expect(wrapper.hidden).toBe(true)
    expect(wrapper).toHaveAttribute('aria-hidden', 'true')
    expect(wrapper).toHaveAttribute('inert')
    expect(taskPageMountCount).toBe(1)

    view.rerender(<TasksHost activeView="tasks" />)

    expect(screen.getByTestId('tasks-page-heading')).toBe(heading)
    expect(heading).toBeVisible()
    expect(wrapper.hidden).toBe(false)
    expect(taskPageMountCount).toBe(1)
  })

  it('does not mount Tasks until the view is opened', () => {
    const view = render(<TasksHost activeView="settings" />)

    expect(screen.queryByTestId('tasks-page-heading')).toBeNull()
    expect(taskPageMountCount).toBe(0)

    view.rerender(<TasksHost activeView="tasks" />)

    expect(screen.getByTestId('tasks-page-heading')).toBeVisible()
    expect(taskPageMountCount).toBe(1)
  })

  it('keeps TaskPage in the workspace shell while another view is active', () => {
    const source = readFileSync(WORKSPACE_SHELL_PATH, 'utf8')
    expect(source).toContain('renderTasksView(activeView, <TaskPage />)')
    expect(source).not.toContain("activeView === 'tasks' ? <TaskPage />")
  })

  it('closes Tasks composer overlays when leaving the view and keeps the draft', () => {
    const previousDraft = useAppStore.getState().newIssueDraft
    useAppStore.getState().setNewIssueDraft({ title: 'keep this draft' })
    try {
      const view = render(<TasksHost activeView="tasks" page={<TasksComposerPage />} />)
      expect(screen.getByRole('dialog', { name: 'New GitHub issue' })).toBeInTheDocument()
      expect(screen.getByTestId('composer-open')).toHaveTextContent('open')

      view.rerender(<TasksHost activeView="settings" page={<TasksComposerPage />} />)

      expect(screen.getByTestId('composer-open')).toHaveTextContent('closed')
      expect(screen.getByTestId('composer-draft')).toHaveTextContent('keep this draft')
      expect(useAppStore.getState().newIssueDraft?.title).toBe('keep this draft')
      expect(screen.queryByRole('dialog', { name: 'New GitHub issue' })).toBeNull()

      view.rerender(<TasksHost activeView="tasks" page={<TasksComposerPage />} />)

      expect(screen.getByTestId('composer-open')).toHaveTextContent('closed')
      expect(screen.getByTestId('composer-draft')).toHaveTextContent('keep this draft')
      expect(screen.queryByRole('dialog', { name: 'New GitHub issue' })).toBeNull()
    } finally {
      if (previousDraft) {
        useAppStore.getState().setNewIssueDraft(previousDraft)
      } else {
        useAppStore.getState().clearNewIssueDraft()
      }
    }
  })

  it('hides selection-driven Tasks sheets while keeping the selected row', () => {
    const view = render(<TasksHost activeView="tasks" page={<TasksSelectedSheetPage />} />)
    expect(screen.getByRole('dialog', { name: 'Issue sheet' })).toBeInTheDocument()
    expect(screen.getByTestId('sheet-open')).toHaveTextContent('open')

    view.rerender(<TasksHost activeView="terminal" page={<TasksSelectedSheetPage />} />)

    expect(screen.getByTestId('sheet-open')).toHaveTextContent('open')
    expect(screen.getByTestId('selected-row')).toHaveTextContent('ORC-21')
    expect(screen.queryByRole('dialog', { name: 'Issue sheet' })).toBeNull()

    view.rerender(<TasksHost activeView="tasks" page={<TasksSelectedSheetPage />} />)

    expect(screen.getByTestId('sheet-open')).toHaveTextContent('open')
    expect(screen.getByTestId('selected-row')).toHaveTextContent('ORC-21')
    expect(screen.getByRole('dialog', { name: 'Issue sheet' })).toBeInTheDocument()
  })

  it('gates Tasks portals from the keep-mounted wrapper', () => {
    const source = readFileSync(TASKS_VIEW_PATH, 'utf8')
    const effectsSource = readFileSync(
      join(process.cwd(), 'src/renderer/src/components/use-task-page-global-effects.ts'),
      'utf8'
    )
    expect(source).toContain('OverlayAllowedContext.Provider')
    expect(source).toContain('value={isVisible}')
    expect(effectsSource).toContain('useDismissTaskPageOverlaysWhenHidden')
    expect(
      readFileSync(join(process.cwd(), 'src/renderer/src/components/ui/dropdown-menu.tsx'), 'utf8')
    ).toContain('useGatedOverlayOpen')
    expect(
      readFileSync(join(process.cwd(), 'src/renderer/src/components/ui/select.tsx'), 'utf8')
    ).toContain('useGatedOverlayOpen')
  })
})
