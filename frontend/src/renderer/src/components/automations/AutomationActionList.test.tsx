// @vitest-environment happy-dom

import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AutomationAction } from '../../../../shared/automations-types'
import { AutomationActionList } from './AutomationActionList'

// Why: act(...) warnings are silenced by opting this module into the React act
// environment, matching how the renderer mounts under test.
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

// Why: base-branch search internals are covered by CreateFromPicker.test.tsx;
// stub it so create_pr rows render without pulling in store/runtime mocks.
vi.mock('./CreateFromPicker', () => ({
  CreateFromPicker: () => <input aria-label="base branch" />
}))

// Why: Radix's DropdownMenu portals its content to document.body and relies
// on floating-ui positioning that happy-dom doesn't implement — stub the
// primitives (as CreateFromPicker.test.tsx does for Popover/Command) so the
// "+ Add action" menu renders inline and items are plain clickable buttons.
vi.mock('@/components/ui/dropdown-menu', () => ({
  DropdownMenu: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DropdownMenuTrigger: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  DropdownMenuContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DropdownMenuItem: ({
    children,
    onSelect
  }: {
    children: React.ReactNode
    onSelect?: () => void
  }) => (
    <button type="button" role="menuitem" onClick={() => onSelect?.()}>
      {children}
    </button>
  )
}))

let container: HTMLDivElement
let root: Root

async function renderList(
  initialActions: AutomationAction[],
  onActionsChange: (actions: AutomationAction[]) => void
): Promise<void> {
  await act(async () => {
    root.render(
      <AutomationActionList
        repoId="repo-1"
        repoMap={new Map()}
        worktrees={[]}
        initialActions={initialActions}
        onActionsChange={onActionsChange}
      />
    )
  })
}

function clickButton(label: string): void {
  // Why: each row renders its own up/down button (disabled at the list's
  // boundary), so more than one element can share this aria-label — only the
  // enabled one should actually receive the click.
  const button = Array.from(container.querySelectorAll('button')).find(
    (candidate) => candidate.getAttribute('aria-label') === label && !candidate.disabled
  )
  if (!button) {
    throw new Error(`button "${label}" not found`)
  }
  button.click()
}

describe('AutomationActionList', () => {
  beforeEach(() => {
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
  })

  afterEach(() => {
    act(() => {
      root.unmount()
    })
    container.remove()
  })

  it('adds a commit_push action from the dropdown and renders its fields', async () => {
    const onActionsChange = vi.fn()
    await renderList([], onActionsChange)

    expect(container.textContent).toContain('No actions yet')

    const addTrigger = Array.from(container.querySelectorAll('button')).find((button) =>
      button.textContent?.includes('Add action')
    )
    expect(addTrigger).toBeDefined()
    await act(async () => {
      addTrigger?.click()
    })

    const commitPushItem = Array.from(container.querySelectorAll('[role="menuitem"]')).find(
      (item) => item.textContent === 'Commit & push'
    )
    expect(commitPushItem).toBeDefined()
    await act(async () => {
      ;(commitPushItem as HTMLElement).click()
    })

    expect(onActionsChange).toHaveBeenLastCalledWith([
      expect.objectContaining({ type: 'commit_push', config: {}, continueOnFailure: false })
    ])
    // The commit_push field set (message input) should now be on screen.
    expect(container.querySelector('input[placeholder="Automated commit"]')).not.toBeNull()
  })

  it('reorders actions with the up/down arrows and updates state order', async () => {
    const onActionsChange = vi.fn()
    const actions: AutomationAction[] = [
      { id: 'a', type: 'commit_push', config: {}, continueOnFailure: false },
      { id: 'b', type: 'create_pr', config: {}, continueOnFailure: false }
    ]
    await renderList(actions, onActionsChange)

    await act(async () => {
      clickButton('Move action down')
    })

    expect(onActionsChange).toHaveBeenLastCalledWith([
      expect.objectContaining({ id: 'b' }),
      expect.objectContaining({ id: 'a' })
    ])

    await act(async () => {
      clickButton('Move action up')
    })

    expect(onActionsChange).toHaveBeenLastCalledWith([
      expect.objectContaining({ id: 'a' }),
      expect.objectContaining({ id: 'b' })
    ])
  })

  it('removes an action from the list and updates state', async () => {
    const onActionsChange = vi.fn()
    const actions: AutomationAction[] = [
      { id: 'a', type: 'commit_push', config: {}, continueOnFailure: false },
      { id: 'b', type: 'create_pr', config: {}, continueOnFailure: false }
    ]
    await renderList(actions, onActionsChange)

    await act(async () => {
      clickButton('Remove action')
    })

    expect(onActionsChange).toHaveBeenLastCalledWith([expect.objectContaining({ id: 'b' })])
  })

  it('toggles continueOnFailure for the right action', async () => {
    const onActionsChange = vi.fn()
    const actions: AutomationAction[] = [
      { id: 'a', type: 'commit_push', config: {}, continueOnFailure: false },
      { id: 'b', type: 'create_pr', config: {}, continueOnFailure: false }
    ]
    await renderList(actions, onActionsChange)

    const checkboxes = Array.from(
      container.querySelectorAll<HTMLButtonElement>('button[role="checkbox"]')
    )
    // Per row, AutomationActionConfigForm's own checkbox (push/draft) renders
    // before the continueOnFailure checkbox: [a.push, a.continueOnFailure,
    // b.draft, b.continueOnFailure].
    const secondActionContinueCheckbox = checkboxes[3]

    await act(async () => {
      secondActionContinueCheckbox.click()
    })

    expect(onActionsChange).toHaveBeenLastCalledWith([
      expect.objectContaining({ id: 'a', continueOnFailure: false }),
      expect.objectContaining({ id: 'b', continueOnFailure: true })
    ])
  })
})
