import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { _setGuestWindowsDriveMountsForTests } from '../../../ipc/wsl-guest-windows-drive-path'
import { OrcaRuntimeService } from '../../orca-runtime'
import './mobile-terminal-chat-fork'
import type { TerminalWorkspaceLaunchScope } from '../../orchestration/terminal-authority/structured-sessions/runtime-legacy-worker-terminal-recovery-types'
import type { MobileTerminalCommand } from './mobile-terminal-startup'
import type { SleepingAgentLaunchConfig } from '../../../../shared/agent-session/lifecycle/agent-session-resume'
import '../../../../shared/execution-host'

let root: string
let windowsBin: string
let nativeBin: string
const originalPlatform = process.platform

function fakeExecutable(dir: string, name: string): string {
  mkdirSync(dir, { recursive: true })
  const file = join(dir, name)
  writeFileSync(file, '#!/bin/sh\n')
  chmodSync(file, 0o755)
  return file
}

function makeRuntime(agentCmdOverrides: Record<string, string> = {}) {
  const runtime = new OrcaRuntimeService(
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: these launch paths read only getSettings for a workspace with no repo or folder.
    {
      getSettings: () => ({
        disabledTuiAgents: [],
        agentCmdOverrides,
        agentDefaultArgs: {},
        agentDefaultEnv: {}
      })
    } as never,
    undefined,
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: ensureAgentSession reads only the claim probe from the local provider.
    { getLocalProvider: () => ({ supportsAgentSessionClaims: async () => true }) as never }
  )
  const workspace: TerminalWorkspaceLaunchScope = {
    id: 'worktree-1',
    path: root,
    connectionId: null,
    repo: null,
    folderWorkspace: null
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: exposes the protected launch builders under test; signatures match mobile-terminal-startup.ts.
  const internal = runtime as unknown as {
    resolveTerminalWorkspaceLaunchScope: () => Promise<TerminalWorkspaceLaunchScope>
    resolveMobileSessionTerminalCommand: (
      workspace: TerminalWorkspaceLaunchScope,
      opts: { agent: 'claude' }
    ) => Promise<MobileTerminalCommand>
    resolveMobileSessionResumeCommand: (
      workspace: TerminalWorkspaceLaunchScope,
      record: {
        agent: 'claude'
        providerSession: { key: 'session_id'; id: string }
        launchConfig?: SleepingAgentLaunchConfig
      }
    ) => { command: string } | null
    getWorkspaceSessionForWorktree: (worktreeId: string) => unknown
    isProviderSessionLiveInAnotherPane: () => Promise<boolean>
    resolvePaneOwnedResumeStartup: (
      worktreeId: string,
      tab: { parentTabId: string; leafId: string }
    ) => Promise<unknown>
  }
  internal.resolveTerminalWorkspaceLaunchScope = async () => workspace
  return { runtime, internal, workspace }
}

const session = { key: 'session_id', id: 'provider-session-1' } as const

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'wsl-host-agent-paths-'))
  const windowsMount = join(root, 'mnt', 'c')
  windowsBin = join(windowsMount, 'Users', 'u', 'AppData', 'Roaming', 'npm')
  nativeBin = join(root, 'usr', 'local', 'bin')
  Object.defineProperty(process, 'platform', { configurable: true, value: 'linux' })
  vi.stubEnv('ORCA_WSL_ORCAD_HOST', '1')
  vi.stubEnv('WSL_DISTRO_NAME', 'Ubuntu')
  // Keep the version-manager search inside the sandbox.
  vi.stubEnv('HOME', join(root, 'home'))
  vi.stubEnv('PATH', `${windowsBin}:${nativeBin}`)
  _setGuestWindowsDriveMountsForTests([windowsMount])
})

afterEach(() => {
  _setGuestWindowsDriveMountsForTests(null)
  vi.unstubAllEnvs()
  Object.defineProperty(process, 'platform', { configurable: true, value: originalPlatform })
  rmSync(root, { recursive: true, force: true })
})

// POSIX paths and exec bits stand in for a distro; Windows runners can't model them.
describe.skipIf(originalPlatform === 'win32')('WSL-host agent launch paths', () => {
  describe('host-built agent session resume', () => {
    const request = {
      kind: 'explicit',
      worktree: 'id:worktree-1',
      agent: 'claude',
      providerSession: session
    } as const

    it('refuses a Windows-only agent', async () => {
      fakeExecutable(windowsBin, 'claude')
      const { runtime } = makeRuntime()
      const createTerminal = vi.spyOn(runtime, 'createTerminal')
      await expect(runtime.ensureAgentSession(request, {})).rejects.toThrow(
        'claude is installed only on Windows'
      )
      expect(createTerminal).not.toHaveBeenCalled()
    })
  })
})
