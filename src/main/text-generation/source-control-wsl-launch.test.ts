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
import { spawnSourceControlAgent } from './source-control-agent-launch'
import { runGenerationRequest } from './agent-generation-request'
import { resolveCommand } from '../git/command-runner/host-routing/wsl-command-resolution'

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

it.skipIf(process.platform === 'win32')(
  'clears profile-restored hook identity after login while preserving shell function commands',
  async () => {
    const directory = realpathSync(mkdtempSync(join(tmpdir(), 'orca-wsl-hook-isolation-')))
    const profile = join(directory, 'rc')
    const shell = join(directory, 'bash')
    const reader = join(directory, 'reader.cjs')
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
      profile,
      `export ORCA_PANE_KEY=profile-pane ORCA_AGENT_PANE=profile-pane ORCA_AGENT_HOOK_PORT=54321 ORCA_AGENT_HOOKS_DISABLED=0
export CODEX_HOME=profile-managed-home
review_agent() { ${quotePosixShell(process.execPath)} ${quotePosixShell(reader)} "$@"; }
`
    )
    writeFileSync(
      reader,
      `console.log(JSON.stringify({
  pane: process.env.ORCA_PANE_KEY ?? null,
  alias: process.env.ORCA_AGENT_PANE ?? null,
  port: process.env.ORCA_AGENT_HOOK_PORT ?? null,
  disabled: process.env.ORCA_AGENT_HOOKS_DISABLED,
  home: process.env.CODEX_HOME,
  args: process.argv.slice(2)
}))
`
    )
    // Run the real guest login command locally; only replace the Windows executable boundary.
    spawnMock.mockImplementationOnce((_program, args, options) =>
      nativeSpawn('/bin/sh', ['-c', args.at(-1)], options)
    )
    try {
      const child = withPlatform('win32', () =>
        spawnSourceControlAgent({
          binary: 'review_agent',
          args: ['literal $HOME'],
          wslDistro: 'Review',
          env: {
            ...process.env,
            HOME: directory,
            SHELL: shell,
            PATH: `${directory}:${process.env.PATH}`
          },
          stdinMode: 'pipe',
          useCwdForNative: true
        })
      )
      let stdout = ''
      let stderr = ''
      child.stdout?.on('data', (chunk) => (stdout += chunk))
      child.stderr?.on('data', (chunk) => (stderr += chunk))
      const closed = new Promise<number | null>((resolve, reject) => {
        child.on('error', reject)
        child.on('close', resolve)
      })
      child.stdin?.end()
      expect(await closed, stderr).toBe(0)
      expect(JSON.parse(stdout)).toEqual({
        pane: null,
        alias: null,
        port: null,
        disabled: '1',
        home: 'profile-managed-home',
        args: ['literal $HOME']
      })
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  }
)

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

it.each([
  { agentId: 'kimi' as const, prompt: String.raw`C:\reference\instructions.md` },
  { agentId: 'kimi' as const, prompt: String.raw`\\wsl$\Foreign\private\instructions.md` },
  { agentId: 'custom' as const, prompt: String.raw`C:\reference\instructions.md` },
  { agentId: 'copilot' as const, prompt: String.raw`C:\reference\instructions.md` },
  { agentId: 'antigravity' as const, prompt: String.raw`C:\reference\instructions.md` }
])(
  'keeps $agentId task text separate from real wrapper paths through the WSL resolver ($prompt)',
  async ({ agentId, prompt }) => {
    const directory = realpathSync(mkdtempSync(join(tmpdir(), 'orca-wsl-task-argv-')))
    const profile = join(directory, 'rc')
    const shell = join(directory, 'bash')
    const report = join(directory, 'report.json')
    const reader = join(directory, 'reader.cjs')
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
      profile,
      `cd() { [ "$1" = /c/repo ]; }\nnode() { ${quotePosixShell(process.execPath)} ${quotePosixShell(reader)} "$@"; }\n`
    )
    writeFileSync(
      reader,
      `const fs=require('node:fs'); const args=process.argv.slice(2); if(args.includes('--help')) { console.log('  --settings Session settings'); } else { const index=args.indexOf('--agent-file'); fs.writeFileSync(${JSON.stringify(report)},JSON.stringify({args,profile:index === -1 ? null : fs.readFileSync(args[index+1],'utf8')})); console.log(${JSON.stringify(agentId === 'kimi' ? JSON.stringify({ role: 'assistant', content: 'Preserve the requested task' }) : agentId === 'antigravity' ? JSON.stringify({ event: 'result', result: { status: 'SUCCESS', response: 'Preserve the requested task' } }) : 'Preserve the requested task')}); }`
    )
    let artifact: string | undefined
    let rejectedModel = false
    spawnMock.mockImplementation((_program, args, options) => {
      if (
        args.includes('wslpath') ||
        args.some((arg) => String(arg).includes('for value do wslpath'))
      ) {
        const values = args.includes('wslpath')
          ? [String(args.at(-1))]
          : args.slice(args.lastIndexOf('--') + 1)
        const output = values
          .map((value: string) => `${value.replace(/^C:[\\/]/, '/c/').replaceAll('\\', '/')}\n`)
          .join('')
        return nativeSpawn(
          process.execPath,
          ['-e', 'process.stdout.write(process.argv[1])', output],
          { ...options, cwd: directory }
        )
      }
      if (args.some((arg) => String(arg).includes('_orca_env=$(command -v env'))) {
        return nativeSpawn(process.execPath, ['-e', 'process.exit(127)'], {
          ...options,
          cwd: directory
        })
      }
      if (args.some((arg) => String(arg).includes('cat -- "$file"'))) {
        expect(args).toContain('/c/repo')
        expect(args).toContain('/c/profiles/agent.md')
        return nativeSpawn(
          process.execPath,
          [
            '-e',
            'console.log(process.argv[1])',
            '--',
            agentId === 'antigravity'
              ? '{"customSetting":true}'
              : '---\nname: reviewer\ntools: [read, write]\n---\nKeep recipe instructions.'
          ],
          { ...options, cwd: directory }
        )
      }
      const guest = args.slice(args.indexOf('--exec') + 1)
      if (agentId === 'copilot' && !rejectedModel) {
        rejectedModel = true
        return nativeSpawn(
          process.execPath,
          [
            '-e',
            `console.error('Error: Model "auto" from --model flag is not available.'); process.exit(1)`
          ],
          { ...options, cwd: directory }
        )
      }
      if (guest[0] === '/bin/sh') {
        artifact = `/tmp/orca-generation-${guest[4]}`
      }
      return nativeSpawn(guest[0], guest.slice(1), { ...options, cwd: directory })
    })
    const platform = process.platform
    Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' })
    try {
      const result = await runGenerationRequest({
        params: {
          agentId,
          model: agentId === 'copilot' ? 'auto' : 'default',
          ...(agentId === 'custom'
            ? {
                customAgentCommand: String.raw`node C:/wrappers/kimi.cjs 'C:\reference\instructions.md' '{prompt}' 'prefix={prompt}:{prompt}'`
              }
            : { agentCommandOverride: 'node C:/wrappers/kimi.cjs' }),
          agentArgs:
            agentId === 'kimi'
              ? String.raw`--agent-file C:/profiles/agent.md --add-dir 'C:\reference\instructions.md'`
              : agentId === 'antigravity'
                ? '--settings C:/profiles/agent.md'
                : undefined
        },
        prompt,
        target: {
          kind: 'local',
          cwd: 'C:/repo',
          wslDistro: 'TaskArgv',
          env: { HOME: directory, SHELL: shell, PATH: `${directory}:${process.env.PATH}` }
        },
        operation: 'commit-message',
        spawnAgent: spawnSourceControlAgent
      })
      expect(result, JSON.stringify(result)).toMatchObject({
        success: true,
        rawOutput: 'Preserve the requested task'
      })
      const receipt = JSON.parse(readFileSync(report, 'utf8'))
      expect(receipt.args[0]).toBe('/c/wrappers/kimi.cjs')
      if (agentId === 'custom') {
        expect(receipt.args.slice(1)).toEqual([
          '/c/reference/instructions.md',
          prompt,
          `prefix=${prompt}:${prompt}`
        ])
      } else if (agentId === 'antigravity') {
        expect(JSON.parse(receipt.args[receipt.args.indexOf('--settings') + 1])).toMatchObject({
          customSetting: true
        })
      } else {
        expect(receipt.args[receipt.args.indexOf('--prompt') + 1]).toBe(prompt)
      }
      if (agentId === 'kimi') {
        expect(receipt.args[receipt.args.indexOf('--add-dir') + 1]).toBe(
          '/c/reference/instructions.md'
        )
        expect(receipt.args[receipt.args.indexOf('--agent-file') + 1]).toMatch(
          /^\/tmp\/orca-generation-[^/]+\/text-task-profile.md$/
        )
        expect(receipt.profile).toContain('tools: []')
        expect(receipt.profile).toContain('Keep recipe instructions.')
      }
      if (agentId === 'copilot') {
        expect(rejectedModel).toBe(true)
        expect(receipt.args).not.toContain('--model')
      }
    } finally {
      Object.defineProperty(process, 'platform', { configurable: true, value: platform })
      if (artifact) {
        await rm(artifact, { recursive: true, force: true })
      }
      await rm(directory, { recursive: true, force: true })
    }
  }
)

it('checks the final quoted WSL command budget even without task files', async () => {
  const platform = process.platform
  Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' })
  try {
    const result = await runGenerationRequest({
      params: { agentId: 'custom', model: 'default', customAgentCommand: 'node {prompt}' },
      prompt: "'".repeat(10_000),
      target: { kind: 'local', cwd: '/home/repo', wslDistro: 'TaskArgv' },
      operation: 'commit-message',
      spawnAgent: spawnSourceControlAgent
    })
    expect(result).toMatchObject({ success: false, errorCode: 'promptTooLargeForWindows' })
    expect(spawnMock).not.toHaveBeenCalled()
  } finally {
    Object.defineProperty(process, 'platform', { configurable: true, value: platform })
  }
})

it('resolves an assigned program path before lowering the env invocation', async () => {
  let invocation = ''
  spawnMock.mockImplementation((_program, args, options) => {
    if (args.includes('wslpath')) {
      expect(args.at(-1)).toBe('C:/tools/agent.exe')
      return nativeSpawn(process.execPath, ['-e', 'console.log("/c/tools/agent.exe")'], options)
    }
    invocation = String(args.at(-1))
    return nativeSpawn(
      process.execPath,
      ['-e', 'console.log("Keep the assigned program")'],
      options
    )
  })
  const platform = process.platform
  Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' })
  try {
    await expect(
      runGenerationRequest({
        params: {
          agentId: 'custom',
          model: 'default',
          customAgentCommand: 'KEEP=literal C:/tools/agent.exe {prompt}'
        },
        prompt: 'requested task',
        target: { kind: 'local', cwd: '/home/repo', wslDistro: 'TaskArgv' },
        operation: 'commit-message',
        spawnAgent: spawnSourceControlAgent
      })
    ).resolves.toMatchObject({ success: true, rawOutput: 'Keep the assigned program' })
    expect(invocation).toContain('/usr/bin/env')
    expect(invocation).toContain('KEEP=literal')
    expect(invocation).toContain('/c/tools/agent.exe')
    expect(invocation).not.toContain('/mnt/c/')
  } finally {
    Object.defineProperty(process, 'platform', { configurable: true, value: platform })
  }
})
