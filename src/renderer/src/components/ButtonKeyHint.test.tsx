// @vitest-environment happy-dom
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { Button } from '@/components/ui/button'
import { ButtonKeyHint } from './ButtonKeyHint'

afterEach(cleanup)

describe('ButtonKeyHint', () => {
  it('shows the modifier before the Enter glyph without joining the button name', () => {
    render(
      <Button>
        Create worktree
        <ButtonKeyHint modifierLabel="⌘" />
      </Button>
    )
    const button = screen.getByRole('button', { name: 'Create worktree' })
    const badge = button.querySelector('[aria-hidden="true"]')
    expect(badge?.textContent).toBe('⌘')
    expect(badge?.querySelector('svg')).toBeTruthy()
  })
  it('shows only the Enter glyph when plain Enter submits', () => {
    const { container } = render(<ButtonKeyHint />)
    expect(container.firstElementChild?.textContent).toBe('')
    expect(container.querySelector('svg')).toBeTruthy()
  })
})
