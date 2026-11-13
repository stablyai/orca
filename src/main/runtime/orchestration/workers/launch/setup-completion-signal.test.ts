import { describe, expect, it, vi } from 'vitest'
import { createSetupCompletionScanner } from './setup-completion-signal'

describe('orchestration setup completion signal', () => {
  it('recognizes one completion signal across output chunk boundaries', () => {
    const onComplete = vi.fn()
    const scanner = createSetupCompletionScanner('token-chunks', onComplete)

    scanner.scan('installing...\r\n__ORCA_SETUP_COMPLETE__:wrong:0\r\n__ORCA_SETUP_COMP')
    scanner.scan('LETE__:token-chunks:1')
    expect(onComplete).not.toHaveBeenCalled()
    scanner.scan('7\r')
    expect(onComplete).not.toHaveBeenCalled()
    scanner.scan('\nPS C:\\repo>')
    scanner.scan('__ORCA_SETUP_COMPLETE__:token-chunks:0\r\n')

    expect(onComplete).toHaveBeenCalledOnce()
    expect(onComplete).toHaveBeenCalledWith(17)
  })
})

it.skipIf(process.platform === 'win32')(
  'observes the exact sequenced Setup invocation once and keeps its failure result',
  async () => {
    const { mkdtempSync, readFileSync, rmSync, writeFileSync } = await import('node:fs')
    const { tmpdir } = await import('node:os')
    const { join } = await import('node:path')
    const { runProcessSync } = await import('@orca/process-host')
    const { createSequencedSetupAgentCommands } =
      await import('../../../../../shared/agent-launch/startup/setup-agent-sequencing')
    const { buildObservedSetupCommand } = await import('./setup-completion-signal')
    const root = mkdtempSync(join(tmpdir(), 'orca-observed-sequence-'))
    const runner = join(root, 'setup.sh')
    try {
      writeFileSync(runner, 'printf x >> "$RUN_RECEIPT"\nexit 17\n')
      const sequence = createSequencedSetupAgentCommands({
        runnerScriptPath: runner,
        startupCommand: 'codex',
        platform: 'posix',
        nonce: 'once'
      })
      const observed = buildObservedSetupCommand(
        runner,
        'posix',
        'token-exact',
        undefined,
        sequence.setupCommand
      )
      const result = runProcessSync({
        program: 'bash',
        args: ['-c', observed.command],
        env: {
          ...process.env,
          ...sequence.setupEnv,
          ...observed.env,
          RUN_RECEIPT: join(root, 'ran')
        }
      })
      expect(result.code).toBe(17)
      expect(readFileSync(join(root, 'ran'), 'utf8')).toBe('x')
      expect(readFileSync(`${runner}.once.done`, 'utf8')).toBe('once:17\n')
      const completed = vi.fn()
      createSetupCompletionScanner('token-exact', completed).scan(result.stdout ?? '')
      expect(completed).toHaveBeenCalledExactlyOnceWith(17)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  }
)

it('keeps deep Windows sequenced invocations out of the typed observer payload', async () => {
  const { createSequencedSetupAgentCommands } =
    await import('../../../../../shared/agent-launch/startup/setup-agent-sequencing')
  const { buildObservedSetupCommand } = await import('./setup-completion-signal')
  const runner = `C:\\${'deep path\\'.repeat(80)}setup.cmd`
  const sequence = createSequencedSetupAgentCommands({
    runnerScriptPath: runner,
    startupCommand: 'codex',
    platform: 'windows'
  })
  const observed = buildObservedSetupCommand(
    runner,
    'windows',
    'token-windows',
    { family: 'cmd' },
    sequence.setupCommand
  )
  expect(observed.env?.ORCA_OBSERVED_SETUP_COMMAND).toBe(sequence.setupCommand)
  expect(observed.command.length).toBeLessThan(1800)
  const gitBash = createSequencedSetupAgentCommands({
    runnerScriptPath: runner,
    startupCommand: 'codex',
    platform: 'windows',
    shell: { family: 'posix' }
  })
  const posixObserved = buildObservedSetupCommand(
    runner,
    'windows',
    'token-gitbash',
    { family: 'posix' },
    gitBash.setupCommand
  )
  expect(posixObserved.command).toMatch(/^bash -lc /)
  expect(posixObserved.command.length).toBeLessThan(1000)
})

it.skipIf(process.platform === 'win32')(
  'runs the generated POSIX example with the owning managed CLI name and quoted arguments',
  async () => {
    const { mkdtempSync, readFileSync, rmSync, writeFileSync } = await import('node:fs')
    const { tmpdir } = await import('node:os')
    const { join } = await import('node:path')
    const { runProcessSync } = await import('@orca/process-host')
    const { projectGroupSetupExample } =
      await import('../../../../../shared/project-group-setup-example')
    const root = mkdtempSync(join(tmpdir(), 'orca-group-cli-example-'))
    const cli = join(root, 'managed cli')
    const receipt = join(root, 'arguments')
    try {
      writeFileSync(cli, '#!/bin/bash\nprintf "%s\\n" "$@" > "$CLI_RECEIPT"\n', { mode: 0o755 })
      const result = runProcessSync({
        program: 'bash',
        args: [
          '-c',
          projectGroupSetupExample([{ id: 'repo-id', displayName: 'Services' }], 'linux')
        ],
        env: {
          ...process.env,
          ORCA_CLI_COMMAND: cli,
          ORCA_WORKSPACE_NAME: 'task & spaced',
          CLI_RECEIPT: receipt
        }
      })
      expect(result.code).toBe(0)
      expect(readFileSync(receipt, 'utf8')).toBe(
        'worktree\ncreate\n--repo\nid:repo-id\n--name\ntask & spaced\n--json\n'
      )
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  }
)
