// @vitest-environment happy-dom

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { useState } from 'react'
import { cleanup, render, screen } from '@testing-library/react'
import '@testing-library/jest-dom/vitest'
import { afterEach, describe, expect, it } from 'vitest'
import type { TopLevelView } from '../../../shared/ui-chrome-types'
import { renderTasksView } from './app-workspace-shell-tasks-view'

const WORKSPACE_SHELL_PATH = join(process.cwd(), 'src/renderer/src/app-shell/AppWorkspaceShell.tsx')

let taskPageMountCount = 0

function TasksPageDouble(): React.JSX.Element {
  const [generation] = useState(() => {
    taskPageMountCount += 1
    return taskPageMountCount
  })
  return <h1 data-testid="tasks-page-heading">Tasks {generation}</h1>
}

function TasksHost({ activeView }: { activeView: TopLevelView }): React.JSX.Element {
  return <>{renderTasksView(activeView, <TasksPageDouble />)}</>
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
})
