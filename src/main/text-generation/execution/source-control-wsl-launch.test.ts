import type * as ChildProcess from 'node:child_process'
import { mkdtempSync, writeFileSync, realpathSync, readFileSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, vi, afterEach } from 'vitest'
import { quotePosixShell } from '../../../shared/shell/launch/shell-argument-quoting'
import '../../../shared/shell/launch/windows-command-line-budget'
import { withPlatform } from './commit-message-text-generation-test-harness'
import { spawnSourceControlAgent } from './source-control-agent-launch'
import { runGenerationRequest } from '../agent-generation-request'

const { spawnMock } = vi.hoisted(() => ({ spawnMock: vi.fn() }))
vi.mock('node:child_process', async (original) => {
  const actual = await original<typeof ChildProcess>()
  spawnMock.mockImplementation(actual.spawn)
  return { ...actual, spawn: spawnMock }
})
vi.mock('../../wsl/discovery/wsl-background-distro-gate', () => ({
  noteWslDistroLaunched: vi.fn()
}))
const nativeSpawn = (await vi.importActual<typeof ChildProcess>('node:child_process')).spawn
afterEach(() => {
  spawnMock.mockReset().mockImplementation(nativeSpawn)
})

it.skipIf(process.platform === 'win32')(
  'clears profile-restored hook identity after login while preserving shell function commands',
  async () => {
    const directory = realpathSync(mkdtempSync(join(tmpdir(), 'orca-wsl-hook-isolation-')))
    const profile = join(directory, 'rc')
    const shell = join(directory, 'bash')
    const reader = join(directory, 'reader.cjs')
    // Ubuntu's /etc/bash.bashrc prints a sudo hint to stdout in a home without this file.
    writeFileSync(join(directory, '.hushlogin'), '')
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

it.skipIf(process.platform === 'win32').each([
  {
    agentId: 'kimi' as const,
    prompt: String.raw`C:\reference\instructions.md '$HOME'; $(exit 91)`
  },
  {
    agentId: 'custom' as const,
    prompt: String.raw`C:\reference\instructions.md '$HOME'; $(exit 91)`
  },
  { agentId: 'kimi' as const, prompt: String.raw`\\wsl$\Foreign\private\instructions.md` },
  { agentId: 'custom' as const, prompt: String.raw`\\wsl$\Foreign\private\instructions.md` },
  { agentId: 'copilot' as const, prompt: String.raw`C:\reference\instructions.md` }
])(
  'preserves $agentId prompt argv ($prompt) while translating separate path operands',
  async ({ agentId, prompt }) => {
    const directory = realpathSync(mkdtempSync(join(tmpdir(), 'orca-wsl-task-argv-')))
    const profile = join(directory, 'rc')
    const shell = join(directory, 'bash')
    const report = join(directory, 'report.json')
    const reader = join(directory, 'reader.cjs')
    writeFileSync(join(directory, '.hushlogin'), '')
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
      join(directory, 'wslpath'),
      `#!/bin/sh\n[ "$1" = -u ] && [ "$2" = 'C:\\' ] && echo /mnt/c/ && exit 0\nexit 1\n`,
      { mode: 0o700 }
    )
    writeFileSync(
      profile,
      `review_agent() { ${quotePosixShell(process.execPath)} ${quotePosixShell(reader)} "$@"; }\n`
    )
    writeFileSync(
      reader,
      `const fs=require('node:fs'); const args=process.argv.slice(2); if (${agentId === 'copilot'} && args.includes('--model')) { console.error('Error: Model "auto" from --model flag is not available.'); process.exit(1); } fs.writeFileSync(${JSON.stringify(report)}, JSON.stringify(args)); console.log(${JSON.stringify(agentId === 'kimi' ? JSON.stringify({ role: 'assistant', content: 'Preserve task text' }) : 'Preserve task text')});`
    )
    const artifacts: string[] = []
    // Exercise the real planner, policy, file staging and login command; replace only wsl.exe.
    spawnMock.mockImplementation((_program, args, options) => {
      const guest = args.slice(args.indexOf('--exec') + 1)
      if (guest[0] === '/bin/sh') {
        artifacts.push(`/tmp/orca-generation-${guest[4]}`)
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
                customAgentCommand: String.raw`TASK_ARGV=1 ${quotePosixShell(process.execPath)} ${quotePosixShell(reader)} C:/wrappers/agent.cjs '{prompt}' 'C:/{prompt}:{prompt}'`,
                agentArgs: '--model default'
              }
            : {
                agentCommandOverride: 'review_agent C:/wrappers/agent.cjs',
                agentArgs:
                  agentId === 'copilot'
                    ? '--effort low --reasoning-effort medium --effort high --add-dir C:/reference/instructions.md'
                    : '--add-dir C:/reference/instructions.md'
              })
        },
        prompt,
        target: {
          kind: 'local',
          wslDistro: 'TaskArgv',
          env: { HOME: directory, SHELL: shell, PATH: `${directory}:${process.env.PATH}` },
          cwd: directory
        },
        operation: 'commit-message',
        spawnAgent: spawnSourceControlAgent
      })
      expect(result).toMatchObject({ success: true, rawOutput: 'Preserve task text' })
      const args = JSON.parse(readFileSync(report, 'utf8'))
      if (agentId === 'copilot') {
        expect(args).not.toContain('--model')
        expect(args).not.toContain('--effort')
        expect(args).not.toContain('--reasoning-effort')
      }
      expect(args[0]).toBe('/mnt/c/wrappers/agent.cjs')
      if (agentId === 'custom') {
        expect(args.slice(1)).toEqual([prompt, `C:/${prompt}:${prompt}`, '--model', 'default'])
      } else {
        expect(args[args.indexOf('--prompt') + 1]).toBe(prompt)
        expect(args[args.indexOf('--add-dir') + 1]).toBe('/mnt/c/reference/instructions.md')
      }
    } finally {
      Object.defineProperty(process, 'platform', { configurable: true, value: platform })
      for (const artifact of artifacts) {
        await rm(artifact, { recursive: true, force: true })
      }
      await rm(directory, { recursive: true, force: true })
    }
  }
)
