// @vitest-environment happy-dom
import '@testing-library/jest-dom/vitest'
import { render, screen, fireEvent, cleanup } from '@testing-library/react'
import { describe, expect, it, vi, beforeEach } from 'vitest'
import { TaskGrantModal } from '../TaskGrantModal'
import { useTaskGrants } from '../../../hooks/useTaskGrants'

vi.mock('../../../hooks/useTaskGrants', () => ({
  useTaskGrants: vi.fn()
}))
const mockUseTaskGrants = vi.mocked(useTaskGrants)

describe('TaskGrantModal', () => {
  const addGrant = vi.fn()
  const revoke = vi.fn()
  const generateShareLink = vi.fn()

  beforeEach(() => {
    cleanup()
    vi.clearAllMocks()
    mockUseTaskGrants.mockReturnValue({
      grants: [],
      addGrant,
      revoke,
      generateShareLink,
      isGranting: false
    })
  })

  it('grants empty → shows "No grant list available yet" message', () => {
    render(<TaskGrantModal taskId="t1" />)
    expect(screen.getByText(/No grant list available yet/)).toBeInTheDocument()
  })

  it('empty subjectId → "Grant access" button disabled', () => {
    render(<TaskGrantModal taskId="t1" />)
    expect(screen.getByTestId('grant-submit')).toBeDisabled()
  })

  it('types subjectId, picks a level, clicks "Grant access" → calls addGrant with the form values', () => {
    render(<TaskGrantModal taskId="t1" />)
    fireEvent.change(screen.getByTestId('grant-subject-input'), {
      target: { value: 'user-42' }
    })
    fireEvent.click(screen.getByTestId('grant-submit'))
    expect(addGrant).toHaveBeenCalledWith('user-42', 'user', false)
  })

  it('renders existing grants with a Revoke button per grant', () => {
    mockUseTaskGrants.mockReturnValue({
      grants: [{ subjectId: 'user-9', level: 'admin' }],
      addGrant,
      revoke,
      generateShareLink,
      isGranting: false
    })
    render(<TaskGrantModal taskId="t1" />)
    expect(screen.getByText('user-9 — admin')).toBeInTheDocument()
    fireEvent.click(screen.getByTestId('revoke-user-9'))
    expect(revoke).toHaveBeenCalledWith('user-9')
  })
})
