import { describe, expect, it, vi } from 'vitest'
import '../../terminal/layout/bind-first-pane.test-fixture'
import '../../../../shared/workspace-layout/layout-owner-switch'
import '../../construction/test-context/runtime-test-module-registration.spec'
import '../../orca-runtime-test-mocks/setup.spec'
import { OrcaRuntimeService } from '../../orca-runtime'
import '../../../browser/agent-browser/agent-browser-bridge'
import type { IPtyProvider } from '../../../providers/pty/provider-contract'
import '../../../git/worktrees/removal/worktree-removal-preflight'
import 'electron'
import '../../../git/worktrees/catalog/worktree-scan-cache'
import { removeWorktree } from '../../../git/worktrees/removal/worktree-removal'
import {
  TEST_WORKTREE_ID,
  store,
  syncSinglePty
} from '../../construction/test-context/orca-runtime-test-fixtures.spec'
import '../../construction/test-context/orca-runtime-test-scenario-builders.spec'

describe('OrcaRuntimeService', () => {
  describe('removeManagedWorktree PTY teardown (design §4.3)', () => {
    function createProviderStub(
      listProcesses: () => Promise<{ id: string; cwd: string; title: string }[]>
    ) {
      return {
        spawn: vi.fn<IPtyProvider['spawn']>(),
        attach: vi.fn<IPtyProvider['attach']>(),
        write: vi.fn<IPtyProvider['write']>(),
        writeWithSettlement: vi.fn<IPtyProvider['writeWithSettlement']>(),
        resize: vi.fn<IPtyProvider['resize']>(),
        shutdown: vi.fn<IPtyProvider['shutdown']>().mockResolvedValue(undefined),
        sendSignal: vi.fn<IPtyProvider['sendSignal']>(),
        getCwd: vi.fn<IPtyProvider['getCwd']>(),
        getInitialCwd: vi.fn<IPtyProvider['getInitialCwd']>(),
        clearBuffer: vi.fn<IPtyProvider['clearBuffer']>(),
        resetInputModes: vi.fn<IPtyProvider['resetInputModes']>(),
        acknowledgeDataEvent: vi.fn<IPtyProvider['acknowledgeDataEvent']>(),
        hasChildProcesses: vi.fn<IPtyProvider['hasChildProcesses']>(),
        getForegroundProcess: vi.fn<IPtyProvider['getForegroundProcess']>(),
        serialize: vi.fn<IPtyProvider['serialize']>(),
        revive: vi.fn<IPtyProvider['revive']>(),
        listProcesses: vi.fn(listProcesses),
        getDefaultShell: vi.fn<IPtyProvider['getDefaultShell']>(),
        getProfiles: vi.fn<IPtyProvider['getProfiles']>(),
        onData: vi.fn<IPtyProvider['onData']>().mockReturnValue(() => {}),
        onReplay: vi.fn<IPtyProvider['onReplay']>().mockReturnValue(() => {}),
        onExit: vi.fn<IPtyProvider['onExit']>().mockReturnValue(() => {})
      } satisfies IPtyProvider
    }

    it('does not start Git removal when physical PTY stop cannot be proven', async () => {
      // Retain the live PTY in fresh inventory so failed stop cannot be mistaken for proven exit.
      const localProvider = createProviderStub(async () => [
        { id: 'pty-1', cwd: '/tmp', title: 'shell' }
      ])
      const runtime = new OrcaRuntimeService(store, undefined, {
        getLocalProvider: () => localProvider
      })
      runtime.setPtyController({
        write: () => true,
        kill: vi.fn(() => true),
        stopAndWait: vi.fn(async () => false),
        getForegroundProcess: async () => null
      })
      await syncSinglePty(runtime, 'pty-1')

      await expect(runtime.removeManagedWorktree(TEST_WORKTREE_ID)).rejects.toThrow(
        'Failed to physically stop every PTY'
      )

      expect(removeWorktree).not.toHaveBeenCalled()
    })
  })
})
