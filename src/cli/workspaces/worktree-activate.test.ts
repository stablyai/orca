import { expect, it, vi } from 'vitest'
import { findCommandSpec } from '../arguments/args'
import { ROOT_HELP_TEXT_PRIMARY } from '../discovery/root-help-text-primary'
import { RuntimeClient } from '../runtime/client'
import { COMMAND_SPECS } from '../specs'
import { WORKTREE_ACTIVATE_HANDLERS } from './worktree-activate'

// [pairing code, environment name, host window outcome, printed line]
it.each([
  [
    null,
    null,
    'requested',
    'Local window only: sent a request to the Orca window on this computer to open scan. No screen changes on any other computer, phone, or Slack.'
  ],
  [
    null,
    'M4 Air',
    'requested',
    'Remote window only (M4 Air): sent a request to the Orca window on M4 Air to open scan. No screen changes on any other computer, phone, or Slack.'
  ],
  [
    'pairing-code',
    null,
    'requested',
    'Remote window only: sent a request to the Orca window on the paired computer to open scan. No screen changes on any other computer, phone, or Slack.'
  ],
  [null, 'M4 Air', 'none', 'No screen changed: no Orca window is open on M4 Air to show scan.'],
  [
    null,
    null,
    'unavailable',
    'No screen changed: could not send the request to the Orca window on this computer to open scan.'
  ],
  [
    null,
    null,
    undefined,
    'Local window only: sent a request to open scan on this computer. This Orca version does not report whether a window received the request. No screen changes on any other computer, phone, or Slack.'
  ]
] as const)(
  'reports the window outcome for %s/%s (%s)',
  async (pairingCode, environment, hostWindow, expected) => {
    const client = new RuntimeClient(process.cwd(), undefined, pairingCode, environment)
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
  }
)

it('describes activation in help as a request to the host window, not an open', () => {
  const spec = findCommandSpec(COMMAND_SPECS, ['worktree', 'activate'])
  const rootLine = ROOT_HELP_TEXT_PRIMARY.split('\n').find((line) =>
    line.trim().startsWith('worktree activate ')
  )
  for (const summary of [spec?.summary, rootLine]) {
    expect(summary).toContain("Ask the host's Orca window to open a worktree")
    expect(summary).not.toContain('Open a worktree')
  }
  expect(spec?.notes).toContain(
    'Prints whether the request reached an Orca window on the host, not that the window switched. No screen changes on any other computer, phone, or Slack.'
  )
})
