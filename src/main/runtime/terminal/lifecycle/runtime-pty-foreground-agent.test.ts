import { describe, expect, it, vi } from 'vitest'
import { RuntimePtyForegroundAgent } from './runtime-pty-foreground-agent'
import type { RuntimePtyController } from './runtime-pty-controller-contract'
import type { RuntimePtyWorktreeRecord } from '../records/runtime-terminal-state-records'

function paneWithForeground(foregroundName: string, scannedName: string) {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: RuntimePtyForegroundAgent reads only these fields of the record.
  const pty = {
    ptyId: 'pty-1',
    connected: true,
    launchAgent: null,
    foregroundAgent: null
  } as unknown as RuntimePtyWorktreeRecord
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: refresh calls only these two controller methods.
  const controller = {
    getForegroundProcess: vi.fn(async () => foregroundName),
    confirmForegroundProcess: vi.fn(async () => scannedName)
  } as unknown as RuntimePtyController
  const foreground = new RuntimePtyForegroundAgent({
    getController: () => controller,
    getPty: () => pty,
    touchSnapshot: () => {},
    finishDelayedSnapshot: () => {}
  })
  return { pty, foreground }
}

describe.skipIf(process.platform === 'win32')('RuntimePtyForegroundAgent.refresh', () => {
  // A pane reattached after an app restart has no launch authority; its native Claude's process
  // name is the versions/<semver> binary it runs, and only a process scan reads `claude`.
  it('names a version-named native Claude as Claude', async () => {
    const { pty, foreground } = paneWithForeground('2.1.330', 'claude')

    await expect(foreground.refresh('pty-1')).resolves.toBe(true)

    expect(pty.foregroundAgent).toBe('claude')
  })
})
