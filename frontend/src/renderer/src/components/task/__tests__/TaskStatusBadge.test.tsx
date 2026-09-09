// @vitest-environment happy-dom
import '@testing-library/jest-dom/vitest'
import { render, screen, cleanup } from '@testing-library/react'
import { describe, expect, it, beforeEach } from 'vitest'
import { TaskStatusBadge, TaskPriorityBadge } from '../TaskStatusBadge'

describe('TaskStatusBadge', () => {
  beforeEach(() => cleanup())

  it('renders in_progress with correct label, icon, and class', () => {
    render(<TaskStatusBadge status="in_progress" />)
    expect(screen.getByText('In Progress')).toBeInTheDocument()
    expect(screen.getByText('🔄')).toBeInTheDocument()
    expect(screen.getByText('In Progress').parentElement).toHaveClass('text-blue-600')
  })

  it('renders done with ✅', () => {
    render(<TaskStatusBadge status="done" />)
    expect(screen.getByText('Done')).toBeInTheDocument()
    expect(screen.getByText('✅')).toBeInTheDocument()
  })

  it('renders cancelled with ❌', () => {
    render(<TaskStatusBadge status="cancelled" />)
    expect(screen.getByText('Cancelled')).toBeInTheDocument()
    expect(screen.getByText('❌')).toBeInTheDocument()
  })

  it('renders todo with ⏳ as fallback or explicit', () => {
    render(<TaskStatusBadge status="todo" />)
    expect(screen.getByText('Todo')).toBeInTheDocument()
    expect(screen.getByText('⏳')).toBeInTheDocument()
  })

  it("renders backlog with label 'Backlog', not a Todo fallback", () => {
    render(<TaskStatusBadge status="backlog" />)
    expect(screen.getByText('Backlog')).toBeInTheDocument()
    expect(screen.getByText('📋')).toBeInTheDocument()
  })

  it("renders review with label 'Review'", () => {
    render(<TaskStatusBadge status="review" />)
    expect(screen.getByText('Review')).toBeInTheDocument()
    expect(screen.getByText('👀')).toBeInTheDocument()
  })

  it("renders blocked with label 'Blocked'", () => {
    render(<TaskStatusBadge status="blocked" />)
    expect(screen.getByText('Blocked')).toBeInTheDocument()
    expect(screen.getByText('🚫')).toBeInTheDocument()
  })
})

describe('TaskPriorityBadge', () => {
  it('renders high priority correctly', () => {
    render(<TaskPriorityBadge priority="high" />)
    expect(screen.getByText('High')).toBeInTheDocument()
    expect(screen.getByText('🟠')).toBeInTheDocument()
  })
})
