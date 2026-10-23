import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ClaudeAgentTeamsService } from '../../claude-agent-teams-service'
import { buildRuntimeAgentTeamsLaunchPlan } from './agent-teams-launch-plan'

const roots: string[] = []

afterEach(async () => {
  vi.unstubAllEnvs()
  await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })))
  roots.length = 0
})

describe('runtime agent teams launch plan', () => {
  it.skipIf(process.platform === 'win32')(
    'prepares the iTerm2 leader env when the teammate mode lives only in saved agent args',
    async () => {
      const root = await mkdtemp(join(tmpdir(), 'orca-agent-teams-plan-'))
      roots.push(root)
      // Why: the plan writes its shims under ~/.orca.
      vi.stubEnv('HOME', root)
      const cliPath = join(root, 'orca-dev')
      await writeFile(cliPath, '#!/usr/bin/env sh\n', 'utf8')
      await chmod(cliPath, 0o755)

      const { effectiveLaunchConfig } = await buildRuntimeAgentTeamsLaunchPlan({
        launchConfig: { agentCommand: 'claude', agentArgs: '--teammate-mode iterm2', agentEnv: {} },
        command: 'claude',
        baseEnv: { PATH: root },
        adoptedBeforeLaunch: undefined,
        claudeAgentTeams: new ClaudeAgentTeamsService(),
        leaderHandle: 'leader'
      })

      const it2ShimDir = join(root, '.orca', 'claude-agent-teams-it2-bin')
      expect(effectiveLaunchConfig?.agentCommand).toBe('claude')
      expect(effectiveLaunchConfig?.agentEnv).toMatchObject({
        ITERM_SESSION_ID: 'w0t0p0:orca-1-pane',
        ORCA_AGENT_TEAMS_IT2_SHIM_DIR: it2ShimDir,
        ORCA_AGENT_TEAMS_IT2_PROBE_SHELL: join(it2ShimDir, 'orca-agent-teams-probe-shell')
      })
      expect(effectiveLaunchConfig?.agentEnv.PATH?.startsWith(`${it2ShimDir}:`)).toBe(true)
    }
  )
})
