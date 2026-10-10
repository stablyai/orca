import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { runProcess } from '@orca/process-host'
import { quotePosixShell } from '../../shared/wsl-login-shell-command'
import { createGitHandlerRelay } from '../../relay/git-handler-test-harness'
import { gitExecFileAsync, gitSpawnAfterWindowsEnvironmentReady } from './runner'

let root = ''
let repo = ''
let script = ''
let marker = ''
let env: NodeJS.ProcessEnv = {}

async function git(args: string[]): Promise<string> {
  const result = await runProcess({ program: 'git', args, cwd: repo, env })
  if (result.code !== 0) {
    throw new Error(result.stderr)
  }
  return result.stdout
}

function sshCommand(identity: string): string {
  return [process.execPath, script, marker, identity].map(quotePosixShell).join(' ')
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'orca-git-network-safety-'))
  repo = join(root, 'repo')
  script = join(root, 'ssh wrapper.cjs')
  marker = join(root, 'ssh calls.jsonl')
  await mkdir(repo)
  const globalConfig = join(root, 'global.gitconfig')
  await writeFile(globalConfig, '')
  env = {
    ...process.env,
    GIT_CONFIG_GLOBAL: globalConfig,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_SSH: undefined,
    GIT_SSH_COMMAND: undefined,
    GIT_SSH_VARIANT: undefined
  }
  await writeFile(
    script,
    "const fs = require('node:fs'); fs.appendFileSync(process.argv[2], JSON.stringify({ args: process.argv.slice(3), prompt: process.env.GIT_TERMINAL_PROMPT, askpass: process.env.SSH_ASKPASS }) + '\\n'); process.exit(1);\n"
  )
  await git(['init', '-q'])
  await git(['remote', 'add', 'origin', 'ssh://example.invalid/repository'])
  vi.stubEnv('GIT_CONFIG_GLOBAL', globalConfig)
  vi.stubEnv('GIT_CONFIG_NOSYSTEM', '1')
  vi.stubEnv('GIT_SSH', undefined)
  vi.stubEnv('GIT_SSH_COMMAND', undefined)
  vi.stubEnv('GIT_SSH_VARIANT', undefined)
})

afterEach(async () => {
  vi.unstubAllEnvs()
  await rm(root, { recursive: true, force: true })
})

async function expectIdentity(identity: string): Promise<void> {
  const calls = (await readFile(marker, 'utf8'))
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line))
  expect(calls.length).toBeGreaterThan(0)
  for (const call of calls) {
    expect(call.args[0]).toBe(identity)
    expect(call.prompt).toBe('0')
    expect(call.askpass).toBe('')
  }
}

describe('network SSH configuration with real Git', () => {
  it.each(['native', 'relay'] as const)(
    '%s honors repository SSH wrappers on ordinary fetches',
    async (host) => {
      await git(['config', 'core.sshCommand', sshCommand('configured identity')])
      if (host === 'native') {
        await expect(gitExecFileAsync(['fetch', 'origin'], { cwd: repo, env })).rejects.toThrow()
      } else {
        const { dispatcher, handler } = createGitHandlerRelay()
        try {
          await expect(
            dispatcher.callRequest('git.fetch', { worktreePath: repo })
          ).rejects.toThrow()
        } finally {
          handler.dispose()
        }
      }
      await expectIdentity('configured identity')
    }
  )

  it('preserves command-line SSH configuration ahead of repository configuration', async () => {
    await git(['config', 'core.sshCommand', sshCommand('repository')])
    await expect(
      gitExecFileAsync(
        ['-c', `core.sshCommand=${sshCommand('command-line')}`, 'ls-remote', 'origin'],
        { cwd: repo, env }
      )
    ).rejects.toThrow()
    await expectIdentity('command-line')
  })

  it.each(['native', 'relay'] as const)('%s preserves an explicit SSH command', async (host) => {
    await git(['config', 'core.sshCommand', sshCommand('repository')])
    const command = sshCommand('environment')
    if (host === 'native') {
      await expect(
        gitExecFileAsync(['fetch', 'origin'], {
          cwd: repo,
          env: { ...env, GIT_SSH_COMMAND: command }
        })
      ).rejects.toThrow()
    } else {
      vi.stubEnv('GIT_SSH_COMMAND', command)
      const { dispatcher, handler } = createGitHandlerRelay()
      try {
        await expect(dispatcher.callRequest('git.fetch', { worktreePath: repo })).rejects.toThrow()
      } finally {
        handler.dispose()
      }
    }
    await expectIdentity('environment')
  })

  it('honors configured global SSH wrappers for streaming clones from a folder', async () => {
    await git(['config', '--global', 'core.sshCommand', sshCommand('clone identity')])
    const child = await gitSpawnAfterWindowsEnvironmentReady(
      ['clone', 'ssh://example.invalid/repository', 'clone'],
      { cwd: root, env, stdio: 'pipe' }
    )
    child.stdout?.resume()
    child.stderr?.resume()
    await new Promise<void>((resolve, reject) => {
      child.once('error', reject)
      child.once('close', () => resolve())
    })
    await expectIdentity('clone identity')
  })
})
