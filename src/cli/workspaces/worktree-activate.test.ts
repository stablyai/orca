import { expect, it, vi } from 'vitest'
import { RuntimeClient } from '../runtime/client'
import { WORKTREE_ACTIVATE_HANDLERS } from './worktree-activate'

it.each([
  [
    null,
    'requested',
    'Local window only: sent a request to the Orca window on this computer to open scan. Nothing changes on any other computer, phone, or Slack.'
  ],
  [
    'M4 Air',
    'requested',
    'Remote window only (M4 Air): sent a request to the Orca window on M4 Air to open scan. Nothing changes on any other computer, phone, or Slack.'
  ],
  ['M4 Air', 'none', 'No screen changed: no Orca window is open on M4 Air to show scan.'],
  [
    null,
    'unavailable',
    'No screen changed: could not send the request to the Orca window on this computer to open scan.'
  ],
  [
    null,
    undefined,
    'Local window only: requested to open scan on this computer. This Orca version does not report whether a window received the request. Nothing changes on any other computer, phone, or Slack.'
  ]
] as const)('reports the window outcome for %s (%s)', async (environment, hostWindow, expected) => {
  const client = new RuntimeClient(process.cwd(), undefined, null, environment)
  vi.spyOn(client, 'call').mockResolvedValue({
    id: 'activate',
    ok: true,
    result: { worktreeId: 'scan', ...(hostWindow ? { hostWindow } : {}) },
    _meta: { runtimeId: 'host' }
  })
  const output = vi.spyOn(console, 'log').mockImplementation(() => {})
  try {
    await WORKTREE_ACTIVATE_HANDLERS['worktree activate']({
      client,
      cwd: process.cwd(),
      flags: new Map([['worktree', 'id:repo::/scan']]),
      json: false
    })
    expect(output.mock.lastCall?.[0]).toBe(expected)
  } finally {
    output.mockRestore()
  }
})
