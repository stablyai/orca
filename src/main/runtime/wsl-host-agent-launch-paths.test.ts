import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { _setGuestWindowsDriveMountsForTests } from '../ipc/wsl-guest-windows-drive-path'
import { OrcaRuntimeService } from './orca-runtime'
import { buildMobileTerminalChatFork } from './terminal/launch/mobile-terminal-chat-fork'
import type { TerminalWorkspaceLaunchScope } from './runtime-legacy-worker-terminal-recovery-types'
import type { MobileTerminalCommand } from './terminal/launch/mobile-terminal-startup'
import type { SleepingAgentLaunchConfig } from '../../shared/agent-session-resume'
import { LOCAL_EXECUTION_HOST_ID } from '../../shared/execution-host'

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
  describe('phone-started agent', () => {
    it('types the distro path', async () => {
      const native = fakeExecutable(nativeBin, 'claude')
      fakeExecutable(windowsBin, 'claude')
      const { internal, workspace } = makeRuntime()
      const launch = await internal.resolveMobileSessionTerminalCommand(workspace, {
        agent: 'claude'
      })
      expect(launch.command?.startsWith(`'${native}' `)).toBe(true)
    })

    it('refuses a Windows-only agent', async () => {
      fakeExecutable(windowsBin, 'claude')
      const { internal, workspace } = makeRuntime()
      await expect(
        internal.resolveMobileSessionTerminalCommand(workspace, { agent: 'claude' })
      ).rejects.toThrow('claude is installed only on Windows')
    })
  })

  describe('phone and restore resume', () => {
    const recorded = { agentCommand: 'claude', agentArgs: '', agentEnv: {} }

    it('pins a recorded stock command to the distro path', () => {
      const native = fakeExecutable(nativeBin, 'claude')
      fakeExecutable(windowsBin, 'claude')
      const { internal, workspace } = makeRuntime()
      const resume = internal.resolveMobileSessionResumeCommand(workspace, {
        agent: 'claude',
        providerSession: session,
        launchConfig: recorded
      })
      expect(resume?.command.startsWith(`'${native}' `)).toBe(true)
    })

    it('leaves a recorded custom command alone', () => {
      fakeExecutable(windowsBin, 'claude')
      const { internal, workspace } = makeRuntime()
      const resume = internal.resolveMobileSessionResumeCommand(workspace, {
        agent: 'claude',
        providerSession: session,
        launchConfig: { ...recorded, agentCommand: 'my-claude' }
      })
      expect(resume?.command.startsWith('my-claude ')).toBe(true)
    })

    // Cold restore falls back to a plain shell instead of resuming through the Windows shim.
    // What a first pinned launch records; resuming it must not re-resolve or re-quote.
    it('keeps a recorded absolute command as recorded', () => {
      const native = fakeExecutable(nativeBin, 'claude')
      fakeExecutable(windowsBin, 'claude')
      const { internal, workspace } = makeRuntime()
      const resume = internal.resolveMobileSessionResumeCommand(workspace, {
        agent: 'claude',
        providerSession: session,
        launchConfig: { ...recorded, agentCommand: `'${native}'` }
      })
      expect(resume?.command.startsWith(`'${native}' `)).toBe(true)
    })

    it('throws the fix-it refusal for a Windows-only agent', () => {
      fakeExecutable(windowsBin, 'claude')
      const { internal, workspace } = makeRuntime()
      expect(() =>
        internal.resolveMobileSessionResumeCommand(workspace, {
          agent: 'claude',
          providerSession: session,
          launchConfig: recorded
        })
      ).toThrow('Or set the claude Command setting')
    })

    it('restores a plain shell, not a Windows-backed resume, on cold restore', async () => {
      fakeExecutable(windowsBin, 'claude')
      const { internal } = makeRuntime()
      const tabId = '11111111-1111-4111-8111-111111111111'
      const leafId = '22222222-2222-4222-8222-222222222222'
      const paneKey = `${tabId}:${leafId}`
      const record = {
        paneKey,
        worktreeId: 'worktree-1',
        agent: 'claude',
        providerSession: session,
        origin: 'live',
        launchConfig: recorded
      }
      internal.getWorkspaceSessionForWorktree = () => ({
        sleepingAgentSessionsByPaneKey: { [paneKey]: record }
      })
      internal.isProviderSessionLiveInAnotherPane = async () => false
      await expect(
        internal.resolvePaneOwnedResumeStartup('worktree-1', {
          parentTabId: tabId,
          leafId
        })
      ).resolves.toEqual({})
      // The same restore resumes once the distro has its own copy.
      const native = fakeExecutable(nativeBin, 'claude')
      const resumed = await internal.resolvePaneOwnedResumeStartup('worktree-1', {
        parentTabId: tabId,
        leafId
      })
      expect(resumed).toMatchObject({ command: expect.stringMatching(`^'${native}' `) })
    })

    it('refuses an explicit resume with the fix-it message', async () => {
      fakeExecutable(windowsBin, 'claude')
      const { runtime, internal } = makeRuntime()
      internal.getWorkspaceSessionForWorktree = () => undefined
      internal.isProviderSessionLiveInAnotherPane = async () => false
      await expect(
        runtime.resumeAgentSessionInWorkspace('worktree-1', {
          agent: 'claude',
          providerSession: session,
          captureHostId: LOCAL_EXECUTION_HOST_ID,
          mutationId: 'resume-1'
        })
      ).resolves.toEqual({
        ok: false,
        reason: 'windows_only_cli',
        message: expect.stringContaining('Or set the claude Command setting')
      })
    })
  })

  describe('host-built agent session resume', () => {
    const request = {
      kind: 'explicit',
      worktree: 'id:worktree-1',
      agent: 'claude',
      providerSession: session
    } as const

    it('types the distro path', async () => {
      const native = fakeExecutable(nativeBin, 'claude')
      fakeExecutable(windowsBin, 'claude')
      const { runtime } = makeRuntime()
      const createTerminal = vi.spyOn(runtime, 'createTerminal').mockResolvedValue({
        handle: 'term',
        tabId: '11111111-1111-4111-8111-111111111111',
        paneKey: '11111111-1111-4111-8111-111111111111:22222222-2222-4222-8222-222222222222',
        ptyId: 'pty',
        worktreeId: 'worktree-1',
        title: null,
        surface: 'background'
      })
      await runtime.ensureAgentSession(request, {})
      expect(createTerminal.mock.calls[0]?.[1]?.command?.startsWith(`'${native}' `)).toBe(true)
    })

    it('refuses a Windows-only agent', async () => {
      fakeExecutable(windowsBin, 'claude')
      const { runtime } = makeRuntime()
      const createTerminal = vi.spyOn(runtime, 'createTerminal')
      await expect(runtime.ensureAgentSession(request, {})).rejects.toThrow(
        'claude is installed only on Windows'
      )
      expect(createTerminal).not.toHaveBeenCalled()
    })

    it('keeps an explicit Command setting', async () => {
      fakeExecutable(windowsBin, 'claude')
      const { runtime } = makeRuntime({ claude: 'my-claude' })
      const createTerminal = vi.spyOn(runtime, 'createTerminal').mockResolvedValue({
        handle: 'term',
        tabId: '11111111-1111-4111-8111-111111111111',
        paneKey: '11111111-1111-4111-8111-111111111111:22222222-2222-4222-8222-222222222222',
        ptyId: 'pty',
        worktreeId: 'worktree-1',
        title: null,
        surface: 'background'
      })
      await runtime.ensureAgentSession(request, {})
      expect(createTerminal.mock.calls[0]?.[1]?.command?.startsWith('my-claude ')).toBe(true)
    })
  })

  describe('chat fork into a terminal', () => {
    const fork = (settings: { agentCmdOverrides?: Record<string, string> } = {}) =>
      buildMobileTerminalChatFork({
        prepared: {
          useRealCodexHome: false,
          cliForkSource: {
            agent: 'claude',
            sourceAgent: 'claude',
            sessionId: 'original-chat',
            filePath: join(root, 'chat.jsonl'),
            cwd: root,
            codexHome: null,
            executionHostPlatform: 'linux'
          }
        },
        settings,
        runtime: {
          platform: 'linux',
          pty: { shellOverride: undefined, terminalWindowsWslDistro: null }
        }
      })

    it('types the distro path', () => {
      const native = fakeExecutable(nativeBin, 'claude')
      fakeExecutable(windowsBin, 'claude')
      expect(fork().command).toContain(`'${native}' `)
    })

    it('refuses a Windows-only agent', () => {
      fakeExecutable(windowsBin, 'claude')
      expect(() => fork()).toThrow('claude is installed only on Windows')
    })

    it('keeps an explicit Command setting', () => {
      fakeExecutable(windowsBin, 'claude')
      expect(fork({ agentCmdOverrides: { claude: 'my-claude' } }).command).toContain('my-claude ')
    })
  })
})
