// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AutomationAction } from '../../../../shared/automations-types'
import { AutomationActionConfigForm } from './AutomationActionConfigForm'

// Why: act(...) warnings are silenced by opting this module into the React act
// environment, matching how the renderer mounts under test.
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

// Why: CreateFromPicker's own behavior (branch search/defaults) is covered by
// CreateFromPicker.test.tsx — stub it here so this suite only exercises how
// CreatePrActionFields wires `base` through it.
vi.mock('./CreateFromPicker', () => ({
  CreateFromPicker: ({
    value,
    onValueChange
  }: {
    value: string
    onValueChange: (next: string) => void
  }) => (
    <input
      aria-label="base branch"
      value={value}
      onChange={(event) => onValueChange(event.target.value)}
    />
  )
}))

let container: HTMLDivElement
let root: Root

function makeAction(overrides: Partial<AutomationAction> = {}): AutomationAction {
  return {
    id: 'action-1',
    type: 'commit_push',
    config: {},
    continueOnFailure: false,
    ...overrides
  }
}

// Why: React reads controlled-input changes via the native value setter;
// assigning `.value` directly is swallowed by React's value tracking.
function setNativeValue(input: HTMLInputElement | HTMLTextAreaElement, text: string): void {
  const prototype = input instanceof HTMLTextAreaElement ? HTMLTextAreaElement : HTMLInputElement
  const setValue = Object.getOwnPropertyDescriptor(prototype.prototype, 'value')?.set
  setValue?.call(input, text)
}

async function renderForm(
  action: AutomationAction,
  onChange: (next: AutomationAction) => void
): Promise<void> {
  await act(async () => {
    root.render(
      <AutomationActionConfigForm
        action={action}
        onChange={onChange}
        repoId="repo-1"
        repoMap={new Map()}
        worktrees={[]}
      />
    )
  })
}

describe('AutomationActionConfigForm', () => {
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

  it('renders commit_push fields and updates config.message on input', async () => {
    const onChange = vi.fn()
    await renderForm(
      makeAction({ type: 'commit_push', config: { message: 'old message' } }),
      onChange
    )

    const messageInput = container.querySelector('input[placeholder="Automated commit"]')
    expect(messageInput).not.toBeNull()
    expect((messageInput as HTMLInputElement).value).toBe('old message')

    await act(async () => {
      setNativeValue(messageInput as HTMLInputElement, 'release notes')
      messageInput?.dispatchEvent(new Event('input', { bubbles: true }))
    })

    expect(onChange).toHaveBeenCalledWith({
      id: 'action-1',
      type: 'commit_push',
      config: { message: 'release notes' },
      continueOnFailure: false
    })
  })

  it('defaults commit_push push checkbox to checked and unchecks via config.push', async () => {
    const onChange = vi.fn()
    await renderForm(makeAction({ type: 'commit_push', config: {} }), onChange)

    const checkbox = container.querySelector('button[role="checkbox"]')
    expect(checkbox?.getAttribute('data-state')).toBe('checked')

    await act(async () => {
      ;(checkbox as HTMLButtonElement).click()
    })

    expect(onChange).toHaveBeenCalledWith({
      id: 'action-1',
      type: 'commit_push',
      config: { push: false },
      continueOnFailure: false
    })
  })

  it('renders create_pr fields and updates config.title/body/base on input', async () => {
    const onChange = vi.fn()
    await renderForm(
      makeAction({ type: 'create_pr', config: { title: '', body: '', base: '' } }),
      onChange
    )

    const titleInput = container.querySelector(
      'input[placeholder="Pull request title"]'
    ) as HTMLInputElement
    expect(titleInput).not.toBeNull()

    await act(async () => {
      setNativeValue(titleInput, 'Ship the new form')
      titleInput.dispatchEvent(new Event('input', { bubbles: true }))
    })
    expect(onChange).toHaveBeenLastCalledWith({
      id: 'action-1',
      type: 'create_pr',
      config: { title: 'Ship the new form', body: '', base: '' },
      continueOnFailure: false
    })

    const bodyTextarea = container.querySelector('textarea') as HTMLTextAreaElement
    await act(async () => {
      setNativeValue(bodyTextarea, 'Adds the action config form.')
      bodyTextarea.dispatchEvent(new Event('input', { bubbles: true }))
    })
    expect(onChange).toHaveBeenLastCalledWith({
      id: 'action-1',
      type: 'create_pr',
      config: { title: '', body: 'Adds the action config form.', base: '' },
      continueOnFailure: false
    })

    const baseInput = container.querySelector('input[aria-label="base branch"]') as HTMLInputElement
    await act(async () => {
      setNativeValue(baseInput, 'develop')
      baseInput.dispatchEvent(new Event('input', { bubbles: true }))
    })
    expect(onChange).toHaveBeenLastCalledWith({
      id: 'action-1',
      type: 'create_pr',
      config: { title: '', body: '', base: 'develop' },
      continueOnFailure: false
    })
  })

  it('defaults create_pr draft checkbox to checked', async () => {
    const onChange = vi.fn()
    await renderForm(makeAction({ type: 'create_pr', config: {} }), onChange)

    const checkbox = container.querySelector('button[role="checkbox"]')
    expect(checkbox?.getAttribute('data-state')).toBe('checked')

    await act(async () => {
      ;(checkbox as HTMLButtonElement).click()
    })

    expect(onChange).toHaveBeenCalledWith({
      id: 'action-1',
      type: 'create_pr',
      config: { draft: false },
      continueOnFailure: false
    })
  })

  it('returns a placeholder for action types with no config form (create_worktree/run_agent)', async () => {
    const onChange = vi.fn()
    await renderForm(makeAction({ type: 'create_worktree' }), onChange)

    expect(container.textContent).toContain(
      'Configuration for this action type is not available yet.'
    )
  })

  it('renders run_script fields (script + env) and shows the arbitrary-shell-command warning', async () => {
    const onChange = vi.fn()
    await renderForm(makeAction({ type: 'run_script', config: { script: '' } }), onChange)

    expect(container.textContent).toContain(
      'This script runs arbitrary shell commands whenever the automation runs — review it carefully.'
    )

    const scriptTextarea = container.querySelector('textarea') as HTMLTextAreaElement
    expect(scriptTextarea).not.toBeNull()
    await act(async () => {
      setNativeValue(scriptTextarea, 'echo hi')
      scriptTextarea.dispatchEvent(new Event('input', { bubbles: true }))
    })
    expect(onChange).toHaveBeenLastCalledWith({
      id: 'action-1',
      type: 'run_script',
      config: { script: 'echo hi' },
      continueOnFailure: false
    })
  })

  it('run_script env editor adds/edits/removes entries via config.env', async () => {
    const onChange = vi.fn()
    await renderForm(
      makeAction({ type: 'run_script', config: { script: '', env: { FOO: '1' } } }),
      onChange
    )

    const envInput = container.querySelector(
      'input[placeholder="KEY=value KEY2=value2"]'
    ) as HTMLInputElement
    expect(envInput.value).toBe('FOO=1')

    // Add a second entry.
    await act(async () => {
      setNativeValue(envInput, 'FOO=1 BAR=2')
      envInput.dispatchEvent(new Event('input', { bubbles: true }))
      envInput.dispatchEvent(new FocusEvent('focusout', { bubbles: true }))
    })
    expect(onChange).toHaveBeenLastCalledWith({
      id: 'action-1',
      type: 'run_script',
      config: { script: '', env: { FOO: '1', BAR: '2' } },
      continueOnFailure: false
    })

    // Edit + remove an entry.
    await act(async () => {
      setNativeValue(envInput, 'BAR=changed')
      envInput.dispatchEvent(new Event('input', { bubbles: true }))
      envInput.dispatchEvent(new FocusEvent('focusout', { bubbles: true }))
    })
    expect(onChange).toHaveBeenLastCalledWith({
      id: 'action-1',
      type: 'run_script',
      config: { script: '', env: { BAR: 'changed' } },
      continueOnFailure: false
    })
  })

  it('renders send_notification fields (channel + message) with a free-text channel hint', async () => {
    const onChange = vi.fn()
    await renderForm(
      makeAction({ type: 'send_notification', config: { channel: '', message: '' } }),
      onChange
    )

    expect(container.textContent).toContain(
      'A free-text label shown in the notification title — not a fixed list of channels.'
    )

    const channelInput = container.querySelector('input[placeholder="default"]') as HTMLInputElement
    expect(channelInput).not.toBeNull()
    await act(async () => {
      setNativeValue(channelInput, 'ops')
      channelInput.dispatchEvent(new Event('input', { bubbles: true }))
    })
    expect(onChange).toHaveBeenLastCalledWith({
      id: 'action-1',
      type: 'send_notification',
      config: { channel: 'ops', message: '' },
      continueOnFailure: false
    })

    const messageTextarea = container.querySelector('textarea') as HTMLTextAreaElement
    await act(async () => {
      setNativeValue(messageTextarea, 'Build finished')
      messageTextarea.dispatchEvent(new Event('input', { bubbles: true }))
    })
    expect(onChange).toHaveBeenLastCalledWith({
      id: 'action-1',
      type: 'send_notification',
      config: { channel: '', message: 'Build finished' },
      continueOnFailure: false
    })
  })
})
