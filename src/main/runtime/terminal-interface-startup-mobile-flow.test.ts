import { expect, it, vi } from 'vitest'
import {
  terminalStartupBinding,
  terminalStartupSnapshot
} from '../../shared/terminal-interface-startup.test-support'
import { TerminalInterfaceAuthority } from '../agent-hooks/server/terminal-interface-authority'
import { projectRuntimeMobileSessionTabs } from './runtime-mobile-session-projection'
import type { RuntimeMobileSessionProjectionHost } from './runtime-mobile-session-projection-contract'
import type { RuntimePtyWorktreeRecord } from './runtime-terminal-state-records'
import type { TerminalProcessInspection } from '../../shared/terminal-process-inspection'

it.each([undefined, 'Keep this editable'])(
  'consumes the startup snapshot through pending handle, cold proof and actual late release (draft=%s)',
  async (draft) => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date', 'performance'] })
    const worktreeId = 'folder:startup'
    const startup = { launchAgent: 'claude' as const, launchToken: 'startup-launch' }
    const binding = { ...terminalStartupBinding, worktreeId }
    const paneKey = binding.paneKey
    let bound = false
    const authority = new TerminalInterfaceAuthority()
    const shell = {
      foregroundProcess: 'bash',
      hasChildProcesses: false,
      terminalInterface: {
        shellForeground: true,
        children: 'no-children' as const,
        capturedAgeMs: 0
      }
    }
    let inspection: TerminalProcessInspection = shell
    const stop = authority.install({
      inventory: () =>
        bound
          ? [
              {
                binding,
                generation: 1,
                launchToken: startup.launchToken,
                local: true,
                blocked: false
              }
            ]
          : [],
      inspect: async () => inspection,
      changed: () => {}
    })
    authority.attachHookBindings(() => (bound ? binding : null))
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the projection reads only identity, connection, launch and title metadata from this inert PTY fixture.
    const pty = {
      ...binding,
      connected: true,
      connectionId: null,
      foregroundAgent: null,
      launchAgent: startup.launchAgent
    } as unknown as RuntimePtyWorktreeRecord
    const host: RuntimeMobileSessionProjectionHost = {
      tabs: new Map(),
      leaves: new Map(),
      ptysById: new Map(),
      getLiveBrowserTabs: () => new Map(),
      getProviderSessionRows: () => [],
      getProviderSessionSnapshot: () => [],
      getStatusSnapshot: () => [],
      getLeafKey: () => paneKey,
      findPty: () => (bound ? pty : null),
      getRetainedStatus: () => null,
      getTrackedTitle: () => null,
      getTitleDisplayClear: () => null,
      issuePtyHandle: () => binding.terminalHandle,
      recordPty: () => pty,
      buildPtyStatus: () => ({}),
      sanitizeGroups: () => [],
      pruneGroupLayout: () => null,
      collectTabIds: () => new Set()
    }
    const project = () => {
      const result = projectRuntimeMobileSessionTabs(
        terminalStartupSnapshot(startup.launchAgent, draft, worktreeId, bound),
        host
      ).tabs[0]
      if (result?.type !== 'terminal') {
        throw new Error('expected projected startup terminal')
      }
      expect(result.launchDraft).toBe(draft)
      expect(result.launchAgent).toBe(startup.launchAgent)
      expect(result).not.toHaveProperty('terminalInterface')
      return {
        ...result,
        terminalInterface: authority.read(binding.ptyId, binding.incarnationId) ?? undefined
      }
    }
    try {
      expect(project()).toMatchObject({ status: 'pending-handle', terminal: null })
      bound = true
      host.ptysById = new Map([[binding.ptyId, pty]])
      await vi.advanceTimersByTimeAsync(3000)
      expect(project()).toMatchObject({
        status: 'ready',
        terminalInterface: { state: 'shell', basis: 'cold' }
      })
      // This raw renderer startup has no universal host registry. A new binding is cold.
      authority.captureHook(
        paneKey,
        binding.terminalHandle
      )({
        token: 'original',
        launchToken: startup.launchToken,
        current: () => true,
        mayRetire: async () => false,
        retire: () => {}
      })
      inspection = {
        ...shell,
        hasChildProcesses: true,
        terminalInterface: {
          ...shell.terminalInterface,
          shellForeground: false,
          children: 'children'
        }
      }
      expect(project()).toMatchObject({ terminalInterface: { state: 'agent', basis: 'hook' } })
      await vi.advanceTimersByTimeAsync(1000)
      inspection = shell
      await vi.advanceTimersByTimeAsync(3000)
      const released = project()
      expect(released).toMatchObject({ terminalInterface: { state: 'shell', basis: 'hook' } })
      expect(released.incarnationId).toBe(binding.incarnationId)
      expect(released.terminal).toBe(binding.terminalHandle)
    } finally {
      stop()
      vi.useRealTimers()
    }
  }
)
