import { spawnProcess } from '@orca/process-host'
import type * as ChildProcess from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, realpathSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, vi, afterEach } from 'vitest'
import { quotePosixShell } from '../../shared/shell/launch/shell-argument-quoting'
import '../../shared/windows-command-line-budget'
import { prepareWslPrompt } from './source-control-prompt-files'
import { producePromptRecords } from './source-control-prompt-producer'
import { planCommitMessageGeneration } from '../../shared/source-control/ai/generation/commit-message-plan'
import { withPlatform } from './commit-message-text-generation-test-harness'
import './source-control-agent-launch'
import './source-control-local-generation'
import { resolveCommand } from '../git/command-runner/wsl-command-resolution'

const { spawnMock } = vi.hoisted(() => ({ spawnMock: vi.fn() }))
vi.mock('node:child_process', async (original) => {
  const actual = await original<typeof ChildProcess>()
  spawnMock.mockImplementation(actual.spawn)
  return { ...actual, spawn: spawnMock }
})
vi.mock('../wsl/discovery/wsl-background-distro-gate', () => ({ noteWslDistroLaunched: vi.fn() }))
const nativeSpawn = (await vi.importActual<typeof ChildProcess>('node:child_process')).spawn
afterEach(() => {
  spawnMock.mockReset().mockImplementation(nativeSpawn)
})
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
