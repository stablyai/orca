import { identityFixture as fixture, PANE } from './terminal-identity.test-fixture'
import '../../orchestration/db/contract-constants'
import '../../orchestration/db/messages/mailbox-routing-page'
import '../../orchestration/db/dispatch-row-writer'
import '../../orchestration/db/attempt-outcome-projection'
import { expect, it, vi } from 'vitest'
import '../../orca-runtime-tests/runtime-test-module-registration.spec'
import '../../rpc/methods/orchestration/runs/runs'
import '../../rpc/methods/orchestration/runs/run-scope'
import '../../../../shared/orca-session-address'
import '../../../../shared/orca-session-address-test-fixture'

it('invalidates actual SSH-held facts on register and finally-release with equal and conflicting claims', async () => {
  const f = fixture()
  const wake = vi.fn()
  const stop = f.owner.crewChanges.subscribe(wake)
  const terminal = { handle: 'term_ssh', paneKey: PANE, processIncarnation: 'remote-process' }
  const first = f.runtime.registerOrchestrationCompatibilitySshAttachment('target', 'one', terminal)
  const equal = f.runtime.registerOrchestrationCompatibilitySshAttachment('target', 'two', terminal)
  expect(wake).toHaveBeenCalledTimes(2)
  expect(f.runtime.getTerminalPaneKey(terminal.handle)).toBe(PANE)
  const ctx = f.runtime.createTerminalIdentityReadContext()
  expect(f.owner.getOrchestrationCompatibilitySshTerminal(terminal.handle, ctx)).toEqual(terminal)
  expect(f.runtime.getTerminalProcessIncarnation(terminal.handle, ctx)).toBe('remote-process')
  const conflict = f.runtime.registerOrchestrationCompatibilitySshAttachment(
    'other-target',
    'three',
    terminal
  )
  try {
    // A changed source owns a fresh finite context; the old context is never retained as authority.
    expect(
      f.owner.getOrchestrationCompatibilitySshTerminal(
        terminal.handle,
        f.runtime.createTerminalIdentityReadContext()
      )
    ).toBeUndefined()
    expect(f.runtime.getTerminalPaneKey(terminal.handle)).toBeNull()
    await Promise.resolve()
  } finally {
    f.runtime.releaseOrchestrationCompatibilitySshAttachment(conflict.attachmentId)
  }
  expect(f.runtime.getTerminalPaneKey(terminal.handle)).toBe(PANE)
  f.runtime.releaseOrchestrationCompatibilitySshAttachment(first.attachmentId)
  expect(f.runtime.getTerminalPaneKey(terminal.handle)).toBe(PANE)
  f.runtime.releaseOrchestrationCompatibilitySshAttachment(equal.attachmentId)
  expect(f.runtime.getTerminalPaneKey(terminal.handle)).toBeNull()
  expect(wake).toHaveBeenCalledTimes(6)
  f.runtime.releaseOrchestrationCompatibilitySshAttachment(equal.attachmentId)
  expect(wake).toHaveBeenCalledTimes(6)
  stop()
})
