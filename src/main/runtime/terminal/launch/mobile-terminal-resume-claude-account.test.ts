import { expect, it } from 'vitest'
import { OrcaRuntimeService } from '../../orca-runtime'
import type { TerminalWorkspaceLaunchScope } from '../../orchestration/terminal-authority/structured-sessions/runtime-legacy-worker-terminal-recovery-types'
import type {
  MobileTerminalResumeCommand,
  ResumableAgentSessionSource
} from './mobile-terminal-startup'

const runtime = new OrcaRuntimeService(
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: a resume command reads only getSettings for a workspace with no repo or folder.
  {
    getSettings: () => ({
      disabledTuiAgents: [],
      agentCmdOverrides: {},
      agentDefaultArgs: {},
      agentDefaultEnv: {}
    })
  } as never
)
// oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: exposes the protected resume builder under test; its signature matches mobile-terminal-startup.ts.
const resume = (
  runtime as unknown as {
    resolveMobileSessionResumeCommand: (
      workspace: TerminalWorkspaceLaunchScope,
      record: ResumableAgentSessionSource
    ) => MobileTerminalResumeCommand | null
  }
).resolveMobileSessionResumeCommand.bind(runtime)
const workspace: TerminalWorkspaceLaunchScope = {
  id: 'worktree-1',
  path: '/repo',
  connectionId: null,
  repo: null,
  folderWorkspace: null
}

it('resumes a pinned Claude session on the account its record names', () => {
  const command = resume(workspace, {
    agent: 'claude',
    providerSession: { key: 'session_id', id: 's-1' },
    claudeAccountId: 'acct-b'
  })

  expect(command?.launchConfig?.claudeAccountId).toBe('acct-b')
})
