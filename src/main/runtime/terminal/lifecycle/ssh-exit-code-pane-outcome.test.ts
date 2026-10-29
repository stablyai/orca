// Main matches window SSH exit-code rules: negative and failed exits retain recoverable panes; clean exits close them (L80 ruling 2).
import { describe, expect, it, vi } from 'vitest'

vi.mock('../../../../shared/layout-owner-switch', () => ({ ORCA_LAYOUT_OWNER_IS_MAIN: true }))

await import('../../orca-runtime-test-mocks.spec')
await import('../../orca-runtime-test-lifecycle.spec')
const { makePaneKey } = await import('../../orca-runtime-test-mocks.spec')
const { HEADLESS_LEAF_ID, TEST_WORKTREE_ID, createRuntimeWithSshLease } =
  await import('../../orca-runtime-test-fixtures.spec')
const { registerBoundPty } = await import('../../bind-first-pane.test-fixture')
const { boundSessionOf } = await import('../../profile-session-store.test-fixture')

function exitedSshPane(tabId: string, ptyId: string, exitCode: number) {
  const runtime = createRuntimeWithSshLease(ptyId, tabId)
  const paneKey = makePaneKey(tabId, HEADLESS_LEAF_ID)
  registerBoundPty(runtime, ptyId, TEST_WORKTREE_ID, 'ssh-target', {
    tabId,
    leafId: HEADLESS_LEAF_ID
  })
  const handle = runtime.resolveTerminalPane(paneKey, TEST_WORKTREE_ID).handle
  runtime.onPtyExit(ptyId, exitCode, undefined, { hostExitConfirmed: true })
  const createTerminal = vi.spyOn(runtime, 'createTerminal').mockResolvedValue({
    handle: 'term-replacement',
    tabId,
    paneKey,
    ptyId: 'pty-replacement',
    worktreeId: TEST_WORKTREE_ID,
    title: null,
    surface: 'background'
  })
  const layoutOf = () => boundSessionOf(runtime).terminalLayoutsByTabId[tabId]
  return { runtime, paneKey, handle, createTerminal, layoutOf }
}

describe('an SSH pane the host says ended (switch on)', () => {
  it.each([
    ['a negative code (absence, no status)', -1],
    ['a failed code (the exited card)', 1]
  ])('keeps the leaf on %s, and recovery starts a shell in it', async (_label, exitCode) => {
    const tabId = `tab-ssh-${exitCode}`
    const ptyId = `ssh:ssh-target@@pty-code${exitCode}`
    const { runtime, paneKey, handle, createTerminal, layoutOf } = exitedSshPane(
      tabId,
      ptyId,
      exitCode
    )

    expect(layoutOf()?.ptyIdsByLeafId?.[HEADLESS_LEAF_ID]).toBe(ptyId)
    await expect(
      runtime.recoverTerminalPane(paneKey, TEST_WORKTREE_ID, handle)
    ).resolves.toMatchObject({ handle: 'term-replacement' })
    expect(createTerminal).toHaveBeenCalledWith(`id:${TEST_WORKTREE_ID}`, {
      tabId,
      leafId: HEADLESS_LEAF_ID,
      focus: false
    })
  })

  it('closes the pane on a clean exit, so nothing recovers into it', async () => {
    const { runtime, paneKey, handle, createTerminal, layoutOf } = exitedSshPane(
      'tab-ssh-clean',
      'ssh:ssh-target@@pty-clean',
      0
    )

    expect(layoutOf()).toBeUndefined()
    await expect(runtime.recoverTerminalPane(paneKey, TEST_WORKTREE_ID, handle)).rejects.toThrow()
    expect(createTerminal).not.toHaveBeenCalled()
  })
})
