import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { createSequencedSetupAgentCommands } from '../../../../shared/agent-launch/startup/setup-agent-sequencing'
import { createSetupCompletionScanner } from '../../orchestration/workers/launch/setup-completion-signal'
import {
  provisionWorktreeTerminals,
  type WorktreeProvisionTerminalOptions,
  type WorktreeTerminalProvisioningHost
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

const DEFAULT_TABS = {
  runCommands: true,
  tabs: [
    { title: 'Dev', command: 'pnpm dev', color: '#ff0000' },
    { title: 'Tests', command: 'pnpm test', color: '#00ff00' }
  ]
}


const setup = { runnerScriptPath: '/repo/.orca/setup.sh', envVars: {} }

function createHost(settings: Record<string, unknown> = {}): {
  host: WorktreeTerminalProvisioningHost
  titles: () => (string | undefined)[]
} {
  const createTerminal = vi.fn<WorktreeTerminalProvisioningHost['createTerminal']>(async () => ({
    handle: `term-${createTerminal.mock.calls.length}`
  }))
  return {
    host: {
      canSpawn: () => true,
      createTerminal,
      setTabTitle: vi.fn(async () => {}),
      setTabColor: vi.fn(async () => {}),
      getSettings: () =>
        // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: provisioning reads only the optional keys each test supplies.
        settings as ReturnType<NonNullable<WorktreeTerminalProvisioningHost['getSettings']>>,
      getPtyId: () => undefined,
      recordSetupCompletionToken: vi.fn()
    },
    titles: () => createTerminal.mock.calls.map(([, options]) => options.title)
  }
}

function provisionWithSetup(
  host: WorktreeTerminalProvisioningHost,
  withSetup = true,
  setupOnly?: boolean,
  defaultTabs?: typeof DEFAULT_TABS,
  callerProvidesSurface = false
) {
  return provisionWorktreeTerminals(host, {
    worktreeSelector: 'id:wt-1',
    worktreeId: 'wt-1',
    worktreePath: '/repo/wt-1',
    ...(withSetup ? { setup } : {}),
    hasStartupTerminal: false,
    ...(setupOnly !== undefined ? { setupOnly } : {}),
    ...(defaultTabs ? { defaultTabs } : {}),
    callerProvidesSurface,
    setupCommandPlatform: 'posix'
  })
}


describe('provisionWorktreeTerminals setup auto-close', () => {
  it('makes host-created setup terminals exit their shell on success only when enabled', async () => {
    const off = createHost({}).host
    await provisionWithSetup(off)
    expect(off.createTerminal).toHaveBeenCalledWith(
      'id:wt-1',
      expect.objectContaining({ command: 'bash /repo/.orca/setup.sh' })
    )

    const on = createHost({ closeSetupTabOnSuccess: true }).host
    await provisionWithSetup(on)
    expect(on.createTerminal).toHaveBeenCalledWith(
      'id:wt-1',
      expect.objectContaining({ command: 'bash /repo/.orca/setup.sh && exit 79' })
    )
  })
})
