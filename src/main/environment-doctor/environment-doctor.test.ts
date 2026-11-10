import { describe, expect, it, vi } from 'vitest'
import {
  runEnvironmentDoctor,
  type EnvironmentDoctorCommandResult,
  type EnvironmentDoctorDeps
} from './environment-doctor'

const ROOT = '/work/repo'
const ok = (stdout = ''): EnvironmentDoctorCommandResult => ({
  code: 0,
  stdout,
  stderr: '',
  timedOut: false
})
const failed = (stderr: string, code = 128): EnvironmentDoctorCommandResult => ({
  code,
  stdout: '',
  stderr,
  timedOut: false
})

function makeDeps(options: {
  files?: Record<string, string>
  installed?: string[]
  agents?: string[]
  git?: (args: readonly string[]) => EnvironmentDoctorCommandResult
  agentStatus?: Record<string, EnvironmentDoctorCommandResult>
  freeBytes?: number
  setup?: EnvironmentDoctorCommandResult
}): EnvironmentDoctorDeps {
  const files = options.files ?? {}
  return {
    platform: 'linux',
    prepare: async () => {},
    run: async (program, args) => {
      if (program === 'git') {
        return options.git?.(args) ?? failed('not a git repository')
      }
      return options.agentStatus?.[program] ?? ok()
    },
    findCommands: async (commands) =>
      new Set(commands.filter((command) => (options.installed ?? ['git']).includes(command))),
    detectAgents: async () => options.agents ?? [],
    readFile: async (path) => files[path.replace(`${ROOT}/`, '')] ?? null,
    exists: async (path) => path.replace(`${ROOT}/`, '') in files,
    isDirectory: async (path) => path === ROOT || path.startsWith(`${ROOT}/`),
    freeBytes: async () => options.freeBytes ?? 50 * 1024 ** 3,
    runSetupScript: vi.fn(async () => options.setup ?? ok())
  }
}

function gitRepo(overrides: Record<string, EnvironmentDoctorCommandResult> = {}) {
  return (args: readonly string[]): EnvironmentDoctorCommandResult => {
    const key = args.join(' ')
    for (const [prefix, result] of Object.entries(overrides)) {
      if (key.startsWith(prefix)) {
        return result
      }
    }
    if (key.startsWith('rev-parse --is-inside-work-tree')) {
      return ok(`true\n${ROOT}\n/work/main/.git\n`)
    }
    if (key === 'symbolic-ref --quiet --short HEAD') {
      return ok('feature\n')
    }
    if (key === 'remote') {
      return ok('origin\n')
    }
    return ok()
  }
}

function statuses(result: Awaited<ReturnType<typeof runEnvironmentDoctor>>) {
  return Object.fromEntries(result.checks.map((check) => [check.id, check.status]))
}

describe('runEnvironmentDoctor', () => {
  it('fails on a missing repo-implied CLI but only warns on a signed-out agent', async () => {
    const result = await runEnvironmentDoctor(
      { worktreePath: ROOT },
      makeDeps({
        files: { 'package.json': '{"packageManager":"pnpm@10.0.0"}' },
        installed: ['git', 'node', 'claude', 'codex'],
        agents: ['claude', 'codex', 'gemini'],
        agentStatus: { claude: failed('', 1) },
        git: gitRepo()
      })
    )

    expect(result.ok).toBe(false)
    expect(statuses(result)).toMatchObject({
      'tool.git': 'pass',
      'tool.node': 'pass',
      'tool.pnpm': 'fail',
      'agent.claude': 'warn',
      'agent.codex': 'pass',
      'agent.cli': 'pass',
      'git.fetch': 'pass',
      'git.push': 'pass',
      'setup.script': 'warn',
      'disk.free': 'pass'
    })
    expect(result.checks.find((check) => check.id === 'agent.claude')?.remediation).toContain(
      'claude auth login'
    )
  })

  it('reports an unreachable remote without leaking the credential in its URL', async () => {
    const result = await runEnvironmentDoctor(
      { worktreePath: ROOT },
      makeDeps({
        git: gitRepo({
          'ls-remote': failed(
            "fatal: unable to access 'https://x-access-token:ghp_secret123@github.com/o/r.git/': 403"
          )
        })
      })
    )

    expect(statuses(result)['git.fetch']).toBe('fail')
    expect(statuses(result)['git.push']).toBeUndefined()
    expect(JSON.stringify(result)).not.toContain('ghp_secret123')
  })

  it('probes push with a dry run that skips hooks and targets a probe ref', async () => {
    const calls: string[] = []
    const deps = makeDeps({
      git: (args) => {
        calls.push(args.join(' '))
        return gitRepo({ push: failed('remote: Permission denied', 1) })(args)
      }
    })
    const result = await runEnvironmentDoctor({ worktreePath: ROOT }, deps)

    expect(statuses(result)['git.push']).toBe('fail')
    expect(calls).toContain(
      'push --dry-run --no-verify --porcelain origin HEAD:refs/heads/orca-env-doctor-push-probe'
    )
  })

  it('runs the setup script only when asked and gates on its exit code', async () => {
    const files = { 'orca.yaml': 'scripts:\n  setup: pnpm install\n' }
    const passive = makeDeps({ files, git: gitRepo() })
    const passiveResult = await runEnvironmentDoctor({ worktreePath: ROOT }, passive)
    expect(passive.runSetupScript).not.toHaveBeenCalled()
    expect(statuses(passiveResult)['setup.run']).toBe('warn')

    const active = makeDeps({ files, git: gitRepo(), setup: failed('ERR_PNPM_NO_LOCKFILE', 1) })
    const activeResult = await runEnvironmentDoctor({ worktreePath: ROOT, runSetup: true }, active)
    expect(active.runSetupScript).toHaveBeenCalledWith({
      worktreePath: ROOT,
      rootPath: '/work/main',
      script: 'pnpm install'
    })
    expect(activeResult.ok).toBe(false)
    expect(activeResult.checks.find((check) => check.id === 'setup.run')).toMatchObject({
      status: 'fail',
      message: 'Setup script exited with code 1.'
    })
    expect(activeResult.checks.find((check) => check.id === 'setup.run')?.remediation).toContain(
      'ERR_PNPM_NO_LOCKFILE'
    )
  })

  it('reads the repo root when started in a subfolder, and fails on an unreadable checkout', async () => {
    const files = { 'package.json': '{"packageManager":"pnpm@10.0.0"}' }
    const fromSubfolder = await runEnvironmentDoctor(
      { worktreePath: `${ROOT}/src` },
      makeDeps({ files, installed: ['git', 'node', 'pnpm'], git: gitRepo() })
    )
    expect(fromSubfolder.worktreePath).toBe(ROOT)
    expect(statuses(fromSubfolder)['tool.pnpm']).toBe('pass')

    const dubious = await runEnvironmentDoctor(
      { worktreePath: ROOT },
      makeDeps({
        git: gitRepo({
          'rev-parse --is-inside-work-tree': failed(
            "fatal: detected dubious ownership in repository at '/work/repo'"
          )
        })
      })
    )
    expect(statuses(dubious)['git.repo']).toBe('fail')
    expect(dubious.ok).toBe(false)
  })

  it('skips Git checks for a folder workspace and fails on a nearly full disk', async () => {
    const result = await runEnvironmentDoctor(
      { worktreePath: ROOT },
      makeDeps({ freeBytes: 512 * 1024 ** 2 })
    )

    expect(statuses(result)).toMatchObject({
      'git.repo': 'pass',
      'agent.cli': 'warn',
      'disk.free': 'fail'
    })
    expect(statuses(result)['git.fetch']).toBeUndefined()
    expect(result.ok).toBe(false)
  })
})
