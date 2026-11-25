import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { createSequencedSetupAgentCommands } from '../../../../shared/agent-launch/startup/setup-agent-sequencing'
import { createSetupCompletionScanner } from '../../orchestration/workers/launch/setup-completion-signal'
import {
  provisionWorktreeTerminals,
  type WorktreeProvisionTerminalOptions
} from './runtime-worktree-terminal-provisioning'

// A terminal worker on a wait-for-setup repo runs setup through the sequenced wrapper; the runtime
// must still see that setup end, or stopping the worker reads it as finished and closes it mid-run.
it.skipIf(process.platform === 'win32')(
  'a wait-for-setup wrapped setup records its completion token and prints it when it ends',
  async () => {
    const directory = mkdtempSync(join(tmpdir(), 'orca-wrapped-setup-'))
    try {
      const runnerScriptPath = join(directory, 'setup.sh')
      writeFileSync(runnerScriptPath, 'echo installing\nexit 3\n')
      const sequenced = createSequencedSetupAgentCommands({
        runnerScriptPath,
        startupCommand: 'claude',
        platform: 'posix',
        completionToken: 'token-wrapped'
      })
      const created: WorktreeProvisionTerminalOptions[] = []
      const recorded = new Map<string, string>()
      await provisionWorktreeTerminals(
        {
          canSpawn: () => true,
          createTerminal: async (_selector, options) => {
            created.push(options)
            // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: provisioning reads only the handle.
            return { handle: 'term_setup' } as never
          },
          setTabTitle: async () => {},
          setTabColor: async () => {},
          getPtyId: (handle) => `pty_${handle}`,
          recordSetupCompletionToken: (ptyId, token) => recorded.set(ptyId, token)
        },
        {
          worktreeSelector: 'id:wt',
          worktreeId: 'wt',
          worktreePath: directory,
          setup: { runnerScriptPath, envVars: sequenced.setupEnv ?? {}, waitForAgentStartup: true },
          hasStartupTerminal: true,
          primaryTerminalHandle: 'term_agent',
          setupCommandPlatform: 'posix',
          observeSetupCompletion: true,
          wrappedSetup: { command: sequenced.setupCommand, completionToken: 'token-wrapped' }
        }
      )
      expect(recorded.get('pty_term_setup')).toBe('token-wrapped')
      const setup = created.find((options) => options.command === sequenced.setupCommand)!
      const output = execFileSync('bash', ['-c', `${setup.command} || true`], {
        env: { ...process.env, ...setup.env },
        encoding: 'utf8'
      })
      let exitCode: number | null = null
      createSetupCompletionScanner('token-wrapped', (code) => {
        exitCode = code
      }).scan(output)
      expect(exitCode).toBe(3)
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  }
)
