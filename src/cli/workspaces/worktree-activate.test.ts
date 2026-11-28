import { expect, it } from 'vitest'
import { formatWorktreeActivate } from './worktree-activate'

it('states which device an activation reached, including headless and older hosts', () => {
  const target = { worktreeId: 'scan' }
  const local = { kind: 'local' } as const
  const remote = { kind: 'remote', name: 'M4 Air' } as const
  expect(formatWorktreeActivate({ ...target, hostWindow: 'open' }, local)).toBe(
    'Local window only: switched Orca on this computer to scan. Nothing changed on any other computer, phone, or Slack.'
  )
  expect(formatWorktreeActivate({ ...target, hostWindow: 'open' }, remote)).toBe(
    'Remote window only (M4 Air): switched Orca on M4 Air to scan. Nothing changed on any other computer, phone, or Slack.'
  )
  expect(formatWorktreeActivate({ ...target, hostWindow: 'none' }, remote)).toBe(
    'No screen changed: no Orca window is open on M4 Air to switch to scan.'
  )
  expect(formatWorktreeActivate(target, local)).toBe('Activated scan')
})
