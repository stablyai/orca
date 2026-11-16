import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { runProcess } from '@orca/process-host'
import { SetupTerminalCompletions } from '../runtime/terminal/wait/setup-terminal-completions'
import { createSequencedSetupAgentCommands } from '../../shared/agent-launch/startup/setup-agent-sequencing'
import { OrcaRuntimeService } from '../runtime/orca-runtime'
import { publishSyntheticExit } from '../ipc/pty/runtime/kill'
import { PtyExitProof } from '../pty/process-retirement/pty-exit-proof'
import type { SetupAttemptRecipe } from '../../shared/agent-launch/startup/setup-attempt-recipe'
import { publishSetupFailureMarker } from './setup-failure-marker'

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true })
  }
})

it.each([false, true])(
  'retains the first exact result when Setup closes (success already accepted: %s)',
  async (success) => {
    const root = mkdtempSync(join(tmpdir(), 'setup-closed-'))
    roots.push(root)
    const windows = process.platform === 'win32'
    const runner = join(root, windows ? 'runner.cmd' : 'runner.sh')
    const effect = join(root, 'started')
    writeFileSync(runner, windows ? '@echo off\r\nexit /b 0\r\n' : '#!/bin/sh\nexit 0\n', {
      mode: 0o755
    })
    const commands = createSequencedSetupAgentCommands({
      runnerScriptPath: runner,
      platform: windows ? 'windows' : 'posix',
      nonce: 'closed-attempt',
      startupCommand: `echo started > "${effect}"`,
      agent: 'codex',
      waitTimeoutSeconds: 3
    })
    const directory = join(root, 'setup-completions')
    mkdirSync(directory)
    const marker = join(directory, 'closed-attempt.done')
    if (success) {
      writeFileSync(marker, 'closed-attempt:0\n')
    }
    writeFileSync(join(directory, 'new-attempt.done'), 'new-attempt:0\n')
    let publication: Promise<void> | undefined
    const registry = new SetupTerminalCompletions(undefined, (recipe, signal) => {
      publication = publishSetupFailureMarker(recipe, signal)
      return publication
    })
    registry.bindRecipe('workspace', {
      runnerScriptPath: runner,
      platform: windows ? 'windows' : 'posix',
      nonce: 'closed-attempt',
      deadline: Number.MAX_SAFE_INTEGER
    })
    registry.begin('setup', 'handle', 'closed-attempt', 'workspace')
    // A dead writer may have acquired publication before it could commit its complete result.
    writeFileSync(`${marker}.claim`, '')
    registry.exit('setup', false)
    await registry.forWorkspace('workspace')
    registry.exit('setup', true)
    await publication
    const run = (command: string, env?: Record<string, string>) =>
      runProcess({
        program: windows ? 'cmd.exe' : 'bash',
        args: windows ? ['/d', '/s', '/c', command] : ['-lc', command],
        env: { ...process.env, ...env },
        timeoutMs: 5000
      })
    // A late successful writer must announce the accepted failure, never replace it with success.
    expect((await run(commands.setupCommand, commands.setupEnv)).code).toBe(success ? 0 : 1)
    for (let reader = 0; reader < 2; reader++) {
      expect((await run(commands.startupCommand, commands.startupEnv)).code).toBe(success ? 0 : 1)
    }
    expect(existsSync(effect)).toBe(success)
    expect(readFileSync(marker, 'utf8')).toBe(success ? 'closed-attempt:0\n' : 'closed-attempt:1\n')
    expect(readFileSync(join(directory, 'new-attempt.done'), 'utf8')).toBe('new-attempt:0\n')
  }
)

class ClosingSetupRuntime extends OrcaRuntimeService {
  arm(recipe: SetupAttemptRecipe): void {
    this.setupTerminalCompletions.bindRecipe('workspace', recipe)
    this.setupTerminalCompletions.begin('setup', 'handle', recipe.nonce, 'workspace')
  }
}

it.each(['confirmed-stop', 'physical-negative-exit'] as const)(
  'ends shell readers after an unverified stop followed by %s',
  async (confirmation) => {
    const root = mkdtempSync(join(tmpdir(), 'setup-close-proof-'))
    roots.push(root)
    const windows = process.platform === 'win32'
    const runner = join(root, windows ? 'runner.cmd' : 'runner.sh')
    const effect = join(root, 'started')
    const commands = createSequencedSetupAgentCommands({
      runnerScriptPath: runner,
      platform: windows ? 'windows' : 'posix',
      nonce: 'late-confirmed-close',
      startupCommand: `echo started > "${effect}"`,
      agent: 'codex',
      waitTimeoutSeconds: 3
    })
    const runtime = new ClosingSetupRuntime()
    runtime.arm({
      runnerScriptPath: runner,
      platform: windows ? 'windows' : 'posix',
      nonce: 'late-confirmed-close',
      deadline: Number.MAX_SAFE_INTEGER
    })
    await runtime.onPtyExit('setup', -1)
    expect(existsSync(join(root, 'setup-completions', 'late-confirmed-close.done'))).toBe(false)
    if (confirmation === 'physical-negative-exit') {
      await runtime.onPtyExit('setup', -1, undefined, { providerExitObserved: true })
    } else {
      publishSyntheticExit(
        { runtime, rememberSyntheticKillExit() {}, sendPtyExitToRenderer() {} },
        'setup',
        -1,
        undefined,
        PtyExitProof.from('stop-confirmed', undefined)
      )
    }
    const result = await runProcess({
      program: windows ? 'cmd.exe' : 'bash',
      args: windows
        ? ['/d', '/s', '/c', commands.startupCommand]
        : ['-lc', commands.startupCommand],
      env: { ...process.env, ...commands.startupEnv },
      timeoutMs: 5000
    })
    expect(result.code).toBe(1)
    expect(existsSync(effect)).toBe(false)
    expect(readFileSync(join(root, 'setup-completions', 'late-confirmed-close.done'), 'utf8')).toBe(
      'late-confirmed-close:1\n'
    )
  }
)
