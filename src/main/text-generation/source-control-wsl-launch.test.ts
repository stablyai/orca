import { spawnProcess } from '@orca/process-host'
import type * as ChildProcess from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, realpathSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, vi, afterEach } from 'vitest'
import { quotePosixShell } from '../../shared/shell-argument-quoting'
import { commandLineLength, MAX_COMMAND_LINE_CHARS } from '../../shared/windows-command-line-budget'
import { prepareWslPrompt } from './source-control-prompt-files'
import { producePromptRecords } from './source-control-prompt-producer'
import { planCommitMessageGeneration } from '../../shared/commit-message-plan'
import {
  withPlatform,
  createMockDiscoveryChild
} from './commit-message-text-generation-test-harness'
import { spawnSourceControlAgent } from './source-control-agent-launch'
import { runLocalPlanForAgent } from './source-control-local-generation'
import { resolveCommand } from '../git/command-runner/wsl-command-resolution'

const { spawnMock } = vi.hoisted(() => ({ spawnMock: vi.fn() }))
vi.mock('node:child_process', async (original) => {
  const actual = await original<typeof ChildProcess>()
  spawnMock.mockImplementation(actual.spawn)
  return { ...actual, spawn: spawnMock }
})
vi.mock('../wsl-background-distro-gate', () => ({ noteWslDistroLaunched: vi.fn() }))
const nativeSpawn = (await vi.importActual<typeof ChildProcess>('node:child_process')).spawn
afterEach(() => {
  spawnMock.mockReset().mockImplementation(nativeSpawn)
})
const repo = '\\\\wsl.localhost\\Actual\\home\\dev\\repo'
function planned(agentId: 'omp' | 'codex' = 'omp') {
  const result = planCommitMessageGeneration(
    {
      agentId,
      model: 'default',
      agentCommandOverride: 'lower=recipe LOWER=UPPER omp --model prefix/model',
      agentArgs: '--thinking high --mode text @user.txt -- recipe-message'
    },
    'request'
  )
  if (!result.ok) {
    throw new Error(result.error)
  }
  return result.plan
}

it.each([undefined, 'Wrong', 'Actual'])(
  'routes UNC before hint %s with Linux assignments retained for OMP only',
  async (hint) => {
    const request = planned()
    const child = createMockDiscoveryChild()
    let guestPath = ''
    const result = withPlatform('win32', () =>
      runLocalPlanForAgent({
        agentId: 'omp',
        plan: request,
        target: {
          kind: 'local',
          cwd: repo,
          wslDistro: hint,
          env: { lower: 'base', LOWER: 'BASE' }
        },
        operation: 'conversation-name',
        spawnAgent: (input) => {
          expect(input.wslDistro).toBe('Actual')
          expect(input.env).toEqual({ lower: 'base', LOWER: 'BASE' })
          expect(input.commandEnv).toEqual({ lower: 'recipe', LOWER: 'UPPER' })
          expect(input.preparation).toBeDefined()
          guestPath = input.args.find((arg) => arg.startsWith('@/tmp/')) ?? ''
          queueMicrotask(() => {
            child.stdout.emit('data', Buffer.from('Useful name'))
            child.emit('close', 0)
          })
          return child
        }
      })
    )
    expect(await result).toMatchObject({ success: true })
    expect(guestPath).toContain('@/tmp/orca-generation-')
  }
)

it('preserves ordinary hinted WSL and unrelated provider no-hint native routing', async () => {
  for (const agentId of ['omp', 'codex'] as const) {
    const request = planned(agentId)
    const child = createMockDiscoveryChild()
    const result = withPlatform('win32', () =>
      runLocalPlanForAgent({
        agentId: 'custom',
        plan: request,
        target: {
          kind: 'local',
          cwd: agentId === 'omp' ? 'C:\\repo' : repo,
          ...(agentId === 'omp' ? { wslDistro: 'Hint' } : {})
        },
        operation: 'conversation-name',
        spawnAgent: (input) => {
          expect(input.wslDistro).toBe(agentId === 'omp' ? 'Hint' : undefined)
          expect(!!input.preparation).toBe(agentId === 'omp')
          queueMicrotask(() => {
            child.stdout.emit('data', Buffer.from('Useful name'))
            child.emit('close', 0)
          })
          return child
        }
      })
    )
    expect(await result).toMatchObject({ success: true })
  }
})

it('launches the original resolved wrapper once, preserving prefix, recipe, translation and assignment timing', () => {
  const request = prepareWslPrompt(planned(), 'Actual')
  spawnMock.mockReturnValueOnce(createMockDiscoveryChild())
  withPlatform('win32', () => {
    const assignments = ['lower=recipe', 'LOWER=UPPER']
    const original = resolveCommand(
      '/usr/bin/env',
      [...assignments, planned().binary, ...request.plan.args],
      repo,
      'Wrong',
      { useWslLoginShell: true }
    )
    spawnSourceControlAgent({
      binary: planned().binary,
      args: request.plan.args,
      cwd: repo,
      commandEnv: planned().env,
      wslDistro: 'Actual',
      preparation: request.preparation,
      stdinMode: 'pipe',
      useCwdForNative: true
    })
    const [binary, args] = spawnMock.mock.calls.at(-1)!
    expect(binary).toBe('wsl.exe')
    expect(args.slice(0, 3)).toEqual(['-d', 'Actual', '--exec'])
    expect(args.slice(3, 7)).toEqual([
      '/bin/sh',
      '-c',
      request.preparation.script,
      'orca-generation'
    ])
    expect(args.slice(9)).toEqual(original.args.slice(3))
    expect(original.args.at(-1)).toContain('/home/dev/repo')
    expect(original.args.at(-1)).toContain('lower=recipe')
    expect(args.join(' ')).toContain('@user.txt')
  })
})

it('checks the exact composed Windows argv at the inclusive boundary before spawning', () => {
  const request = prepareWslPrompt(planned(), 'Actual')
  const launch = (padding: number) =>
    withPlatform('win32', () =>
      spawnSourceControlAgent({
        binary: 'omp',
        args: [...request.plan.args, 'x'.repeat(padding)],
        cwd: repo,
        wslDistro: 'Actual',
        preparation: request.preparation,
        stdinMode: 'pipe',
        useCwdForNative: true
      })
    )
  spawnMock.mockReturnValue(createMockDiscoveryChild())
  launch(0)
  const [binary, args] = spawnMock.mock.calls.at(-1)!
  const slack = MAX_COMMAND_LINE_CHARS - commandLineLength([binary, ...args])
  const padding = Math.floor(slack / 3)
  launch(padding)
  const [atBinary, atArgs] = spawnMock.mock.calls.at(-1)!
  expect(commandLineLength([atBinary, ...atArgs])).toBeLessThanOrEqual(MAX_COMMAND_LINE_CHARS)
  expect(commandLineLength([atBinary, ...atArgs])).toBeGreaterThan(MAX_COMMAND_LINE_CHARS - 3)
  const count = spawnMock.mock.calls.length
  expect(() => launch(padding + 1)).toThrow()
  expect(spawnMock).toHaveBeenCalledTimes(count)
})

it.each([false, true])(
  'prepares before hostile profiles and preserves login invocation/cwd/env (assigned=%s)',
  async (assigned) => {
    const directory = realpathSync(mkdtempSync(join(tmpdir(), 'orca-c3-profiles-')))
    const repoPath = join(directory, 'repo')
    const startup = join(directory, 'startup')
    const changed = join(directory, 'profile-cwd')
    const reportPath = join(directory, 'report.json')
    if (!assigned) {
      mkdirSync(repoPath)
    }
    mkdirSync(startup)
    mkdirSync(changed)
    const shell = join(directory, 'bash')
    const profile = join(directory, 'rc')
    writeFileSync(
      shell,
      `#!/bin/sh\nexec /bin/bash --noprofile --rcfile ${quotePosixShell(profile)} -ic "$2"\n`,
      { mode: 0o700 }
    )
    writeFileSync(
      join(directory, 'getent'),
      `#!/bin/sh\nprintf '%s\\n' ${quotePosixShell(`user:x:1:1:User:${directory}:${shell}`)}\n`,
      { mode: 0o700 }
    )
    writeFileSync(
      join(directory, '.profile'),
      `export PATH=${quotePosixShell(directory)}:"$PATH"\n`
    )
    writeFileSync(
      profile,
      `
export STARTUP_CWD="$PWD"
export PROFILE_LOWER="$lower"
if IFS= read -r stolen; then export STOLEN=yes; else export STOLEN=no; fi
alias mkdir='mkdir -pv'
alias printf='printf CORRUPTED'
set -C
command mkdir -p ${quotePosixShell(repoPath)}
cd ${quotePosixShell(changed)}
omp() { ${quotePosixShell(process.execPath)} ${quotePosixShell(join(directory, 'reader.cjs'))} "$@"; }
`
    )
    writeFileSync(
      join(directory, 'reader.cjs'),
      String.raw`
const fs=require('node:fs'); const path=process.argv.find(arg=>arg.startsWith('@/tmp/')).slice(1);
fs.writeFileSync(process.env.REPORT, JSON.stringify({startup:process.env.STARTUP_CWD,cwd:process.cwd(),stolen:process.env.STOLEN,profileLower:process.env.PROFILE_LOWER,lower:process.env.lower,content:new TextDecoder().decode(fs.readFileSync(path)),stdin:fs.readFileSync(0).length,mask:process.umask()}));
`
    )
    const request = prepareWslPrompt(planned(), 'Actual')
    // Use the actual resolved native cwd and original wrapper, without starting a guest on this Mac.
    const original = withPlatform('win32', () =>
      resolveCommand(
        assigned ? '/usr/bin/env' : 'omp',
        assigned
          ? [
              'lower=recipe',
              'LOWER=UPPER',
              process.execPath,
              join(directory, 'reader.cjs'),
              ...request.plan.args
            ]
          : request.plan.args,
        `\\\\wsl.localhost\\Actual${repoPath.replaceAll('/', '\\')}`,
        undefined,
        { useWslLoginShell: true }
      )
    )
    const child = spawnProcess({
      program: '/bin/sh',
      args: [
        '-c',
        request.preparation.script,
        'fixture',
        ...request.preparation.args,
        ...original.args.slice(3)
      ],
      cwd: startup,
      env: { ...process.env, HOME: directory, SHELL: shell, REPORT: reportPath, lower: 'base' },
      stdio: 'pipe'
    })
    child.stdin.on('error', () => {})
    const stop = new AbortController()
    const closed = new Promise<number | null>((resolve, reject) => {
      child.on('close', resolve)
      child.on('error', reject)
    })
    child.stderr.on('data', (chunk) => {
      if (request.observe(chunk)) {
        void producePromptRecords(
          child.stdin,
          request.records(),
          stop.signal,
          () => !stop.signal.aborted
        )
      }
    })
    try {
      expect(await closed).toBe(0)
      const receipt = JSON.parse(readFileSync(reportPath, 'utf8'))
      expect(receipt).toMatchObject({
        startup,
        cwd: repoPath,
        stolen: 'no',
        profileLower: 'base',
        lower: assigned ? 'recipe' : 'base',
        content: 'request',
        stdin: 0
      })
      expect(receipt.mask).toBe(process.umask())
    } finally {
      stop.abort()
      await rm(`/tmp/orca-generation-${request.preparation.args[0]}`, {
        recursive: true,
        force: true
      })
      await rm(directory, { recursive: true, force: true })
    }
  }
)
