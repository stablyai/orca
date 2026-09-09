// @vitest-environment happy-dom
import '@testing-library/jest-dom/vitest'
import { render, screen, cleanup } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { UserRoleBadge } from '../UserRoleBadge'

describe('UserRoleBadge', () => {
  afterEach(cleanup)

  it('renders "developer" label for developer role', () => {
    render(<UserRoleBadge role="developer" />)
    expect(screen.getByText('developer')).toBeInTheDocument()
  })

  it('renders "admin" label with role-badge--admin class', () => {
    const { container } = render(<UserRoleBadge role="admin" />)
    expect(container.firstChild).toHaveClass('role-badge--admin')
    expect(screen.getByText('admin')).toBeInTheDocument()
  })

  it('applies base role-badge class for all roles', () => {
    const { container } = render(<UserRoleBadge role="developer" />)
    expect(container.firstChild).toHaveClass('role-badge')
    expect(container.firstChild).toHaveClass('role-badge--developer')
  })
})
