import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { setupPtyIpcSuite } from './pty-ipc-test-harness'
import {
  recordOf,
  restoreMainPlatform,
  setMainPlatform,
  startParityLanes,
  type ParityLanes
} from './pty-launch-parity.test-fixture'
import type { HostLaunchCase } from './pty-launch-parity-host.test-cases'
import { POSIX_PATH } from '../../../shared/launch-parity-window-cases.test-fixture'
import { launchWorkspaceId } from '../../../shared/launch-parity-window-request.test-fixture'
import { probeOpenCodeLaunchCapabilities } from '../../opencode/opencode-launch-capabilities'
import { probeOpenCodeLaunchModelContext } from '../../opencode/opencode-launch-model-context'
import { tokenizeStartupCommand } from '../../../shared/tui-agent-startup-shell'
import { mergeWorktree } from '../worktree-metadata-merge'

type OpenCodeHostPreparationDependencies = {
  stubOpenCodeV2: () => void
  runHostCall: (
    lanes: ParityLanes,
    request: Pick<HostLaunchCase, 'call' | 'row' | 'workspace'>
  ) => Promise<unknown>
}

export function registerOpenCodeHostPreparationTests({
  stubOpenCodeV2,
  runHostCall
}: OpenCodeHostPreparationDependencies): void {
  const POSIX_REPO = { kind: 'repo', path: POSIX_PATH } as const
  describe('OpenCode host preparation through launch owners', () => {
    const suite = setupPtyIpcSuite()
    const model = 'private/team-model'
    const original = JSON.stringify({
      default_agent: 'reviewer',
      agents: { reviewer: { model: 'previous/model', system: 'Review only' } },
      theme: 'dark'
    })
    const settings = {
      agentCmdOverrides: { opencode: 'host-opencode' },
      agentPermissionDefault: 'own',
      agentDefaultEnv: { opencode: { OPENCODE_CONFIG_CONTENT: original, HOST_ENV: 'server' } }
    }
    beforeEach(() => {
      stubOpenCodeV2()
      vi.mocked(probeOpenCodeLaunchModelContext).mockResolvedValue({ primaryAgent: 'reviewer' })
      setMainPlatform('darwin')
    })
    afterEach(() => restoreMainPlatform())

    it.each(['2.0.16', '1.18.35'])(
      'strict createAgentSession prepares OpenCode %s on the host',
      async (version) => {
        const legacy = version.startsWith('1.')
        vi.mocked(probeOpenCodeLaunchCapabilities).mockResolvedValue({
          version,
          pluginApi: legacy ? 'v1' : 'v2',
          promptMode: legacy ? 'submit' : 'prefill'
        })
        const lanes = startParityLanes(suite, { workspace: POSIX_REPO, settings })
        const result = recordOf(
          await runHostCall(lanes, {
            row: '7',
            workspace: POSIX_REPO,
            call: {
              kind: 'rpc',
              method: 'terminal.createAgentSession',
              params: {
                worktree: `id:${launchWorkspaceId(POSIX_REPO)}`,
                agent: 'opencode',
                prompt: 'Review this project',
                promptDelivery: 'auto-submit',
                sessionOptions: { model },
                agentArgs: null
              }
            }
          })
        )
        const spawned = recordOf(lanes.provider.mock.calls[0]?.[0])
        const env = recordOf(spawned.env)
        const command = String(spawned.command)
        expect(lanes.provider).toHaveBeenCalledOnce()
        expect(probeOpenCodeLaunchCapabilities).toHaveBeenCalledWith(
          expect.objectContaining({
            command: 'host-opencode',
            cwd: POSIX_PATH,
            env: expect.objectContaining({ HOST_ENV: 'server', OPENCODE_CONFIG_CONTENT: original })
          })
        )
        expect(command).toContain('host-opencode')
        expect(tokenizeStartupCommand(command, 'posix')).toMatchObject({
          ok: true,
          tokens: expect.arrayContaining(legacy ? ['--model', model] : ['--standalone'])
        })
        if (legacy) {
          expect(command).not.toContain('--standalone')
          expect(env.OPENCODE_CONFIG_CONTENT).toBe(original)
          expect(probeOpenCodeLaunchModelContext).not.toHaveBeenCalled()
        } else {
          expect(command).not.toContain('--model')
          expect(JSON.parse(String(env.OPENCODE_CONFIG_CONTENT))).toEqual({
            ...JSON.parse(original),
            model,
            agents: { reviewer: { model, system: 'Review only' } }
          })
          expect(probeOpenCodeLaunchModelContext).toHaveBeenCalledOnce()
          expect(recordOf(result.terminal).launchConfig).toMatchObject({
            agentCommand: 'host-opencode',
            agentArgs: '',
            agentEnv: { OPENCODE_CONFIG_CONTENT: original, HOST_ENV: 'server' }
          })
        }
        expect(env.HOST_ENV).toBe('server')
      }
    )

    it('launchAgentTerminal prepares v2 in the resolved existing folder and retains resume inputs', async () => {
      const workspace = {
        kind: 'folder',
        path: POSIX_PATH,
        repoPath: `${POSIX_PATH}/repo`
      } as const
      const lanes = startParityLanes(suite, { workspace, settings })
      const scope = await lanes.runtime.resolveTerminalWorkspaceLaunchScope(
        `id:${launchWorkspaceId(workspace)}`
      )
      if (!scope.folderWorkspace) {
        throw new Error('Expected the folder fixture')
      }
      const repo = {
        id: 'repo-1',
        path: workspace.repoPath,
        displayName: 'project',
        badgeColor: '#000000',
        addedAt: 0
      }
      const git = {
        path: workspace.path,
        head: 'abc',
        branch: 'main',
        isMainWorktree: true,
        isBare: false
      }
      const worktree = {
        ...mergeWorktree(repo.id, git, undefined),
        id: scope.id,
        hostId: 'local' as const,
        parentWorktreeId: null,
        childWorktreeIds: [],
        lineage: null,
        git
      }
      const create = vi.spyOn(lanes.runtime, 'createTerminal')
      const result = await lanes.runtime.launchAgentTerminal(
        `id:${scope.id}`,
        {
          agent: 'opencode',
          prompt: 'Review the folder',
          sessionOptions: { model },
          suppressStartupUpdatePrompt: true
        },
        { worktree, repo, folderWorkspace: scope.folderWorkspace }
      )
      const spawned = recordOf(lanes.provider.mock.calls[0]?.[0])
      expect(lanes.provider).toHaveBeenCalledOnce()
      expect(create).toHaveBeenCalledWith(
        `id:${scope.id}`,
        expect.any(Object),
        undefined,
        worktree,
        scope.folderWorkspace
      )
      expect(spawned.cwd).toBe(workspace.path)
      expect(String(spawned.command)).toContain('--standalone')
      expect(String(spawned.command)).not.toContain('--model')
      expect(JSON.parse(String(recordOf(spawned.env).OPENCODE_CONFIG_CONTENT))).toMatchObject({
        model,
        agents: { reviewer: { model, system: 'Review only' } }
      })
      expect(probeOpenCodeLaunchModelContext).toHaveBeenCalledWith(
        expect.objectContaining({ cwd: workspace.path })
      )
      expect(result.launchConfig).toMatchObject({
        agentCommand: 'host-opencode',
        agentArgs: '',
        agentEnv: { OPENCODE_CONFIG_CONTENT: original, HOST_ENV: 'server' }
      })
    })
  })
}
