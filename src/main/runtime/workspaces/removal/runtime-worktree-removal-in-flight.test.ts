import { expect, it } from 'vitest'
import { WorktreeRemovalNotStartedError } from '../../../workspaces/removal/worktree-removal-expectation'
import { RuntimeWorktreeRemovalInFlight } from './runtime-worktree-removal-in-flight'

it('joins a removal with the same options and refuses one with other options', () => {
  const inFlight = new RuntimeWorktreeRemovalInFlight()
  const removal = Promise.resolve({})
  inFlight.track('scope', 'force=0', removal)
  expect(inFlight.get('scope', 'repo::/w', 'force=0')).toBe(removal)
  expect(() => inFlight.get('scope', 'repo::/w', 'force=1')).toThrow(
    'Worktree deletion already in progress: repo::/w'
  )
})

it("tells a guarded caller its own removal never started when options don't match", () => {
  const inFlight = new RuntimeWorktreeRemovalInFlight()
  inFlight.track('scope', 'force=0', Promise.resolve({}))
  let refusal: unknown
  try {
    inFlight.get('scope', 'repo::/w', 'force=1', true)
  } catch (error) {
    refusal = error
  }
  expect(refusal).toBeInstanceOf(WorktreeRemovalNotStartedError)
  expect(refusal).toMatchObject({ message: 'Worktree deletion already in progress: repo::/w' })
})
