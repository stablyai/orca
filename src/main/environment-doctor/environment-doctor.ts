import { join } from 'node:path'
import type {
  EnvironmentDoctorCheck,
  EnvironmentDoctorResult
} from '../../shared/environment-doctor-types'
import { tuiAgentDisplayName } from '../../shared/agent-launch/catalog/tui-agent-display-names'
import { inferRepoToolRequirements } from './repo-tool-requirements'
import {
  check,
  PROBE_TIMEOUT_MS,
  runSafely,
  type EnvironmentDoctorDeps,
  type EnvironmentDoctorOptions
} from './environment-doctor-check'
import { checkGit, probeGitCheckout, type GitCheckoutProbe } from './environment-doctor-git'
import { checkSetup } from './environment-doctor-setup'

export type {
  EnvironmentDoctorCommandResult,
  EnvironmentDoctorDeps,
  EnvironmentDoctorOptions
} from './environment-doctor-check'

const GIB = 1024 ** 3
const DISK_FAIL_BYTES = 1 * GIB
const DISK_WARN_BYTES = 5 * GIB

// Exit codes only: CLI status wording changes between releases (skill §4).
const AGENT_SIGN_IN_PROBES: Readonly<
  Record<string, { command: string; args: string[]; signIn: string }>
> = {
  claude: { command: 'claude', args: ['auth', 'status'], signIn: 'claude auth login' },
  codex: { command: 'codex', args: ['login', 'status'], signIn: 'codex login --device-auth' }
}

export async function runEnvironmentDoctor(
  options: EnvironmentDoctorOptions,
  deps: EnvironmentDoctorDeps
): Promise<EnvironmentDoctorResult> {
  if (!(await deps.isDirectory(options.worktreePath))) {
    return buildResult(options.worktreePath, [
      check(
        'workspace',
        'workspace.path',
        'fail',
        `Path is not a directory: ${options.worktreePath}`,
        { remediation: 'Run the doctor from the workspace checkout, or pass --path.' }
      )
    ])
  }
  await deps.prepare()
  const hasGit = (await deps.findCommands(['git'])).has('git')
  const checkout: GitCheckoutProbe = hasGit
    ? await probeGitCheckout(options.worktreePath, deps)
    : { kind: 'not-checkout' }
  const root = checkout.kind === 'checkout' ? checkout.root : options.worktreePath
  const readRepoFile = (relativePath: string): Promise<string | null> =>
    deps.readFile(join(root, relativePath))
  const repoFileExists = (relativePath: string): Promise<boolean> =>
    deps.exists(join(root, relativePath))

  const requirements = await inferRepoToolRequirements(readRepoFile, repoFileExists, deps.platform)
  const found = await deps.findCommands(requirements.map((entry) => entry.command))
  const toolChecks: EnvironmentDoctorCheck[] = [
    hasGit
      ? check('tools', 'tool.git', 'pass', 'git is installed.')
      : check('tools', 'tool.git', 'fail', 'git is not on PATH.', {
          remediation: 'Install git in the environment image.'
        }),
    ...requirements.map((requirement) =>
      found.has(requirement.command)
        ? check(
            'tools',
            `tool.${requirement.command}`,
            'pass',
            `${requirement.command} is installed (needed by ${requirement.reason}).`
          )
        : check(
            'tools',
            `tool.${requirement.command}`,
            'fail',
            `${requirement.command} is not on PATH, but ${requirement.reason} needs it.`,
            {
              remediation: `Install ${requirement.command} in the environment image or setup script.`
            }
          )
    )
  ]

  const [agentChecks, gitChecks, diskChecks] = await Promise.all([
    checkAgents(root, deps),
    hasGit ? checkGit(checkout, deps) : Promise.resolve([]),
    checkDisk(root, deps)
  ])
  const setupChecks = await checkSetup(deps, {
    root,
    runSetup: options.runSetup === true,
    checkout,
    impliesInstall: requirements.length > 0,
    readRepoFile
  })

  return buildResult(root, [
    ...toolChecks,
    ...agentChecks,
    ...gitChecks,
    ...setupChecks,
    ...diskChecks
  ])
}

async function checkAgents(
  worktreePath: string,
  deps: EnvironmentDoctorDeps
): Promise<EnvironmentDoctorCheck[]> {
  const agents = await deps.detectAgents().catch((): string[] => [])
  if (agents.length === 0) {
    return [
      check('agents', 'agent.cli', 'warn', 'No coding-agent CLI was found on PATH.', {
        remediation: 'Install the agent you run here (for example claude or codex).'
      })
    ]
  }
  const probed = agents.filter((agent) => AGENT_SIGN_IN_PROBES[agent])
  const others = agents.filter((agent) => !AGENT_SIGN_IN_PROBES[agent])
  const checks = await Promise.all(
    probed.map(async (agent): Promise<EnvironmentDoctorCheck> => {
      const name = tuiAgentDisplayName(agent) ?? agent
      const probe = AGENT_SIGN_IN_PROBES[agent]
      const result = await runSafely(deps, probe.command, probe.args, {
        cwd: worktreePath,
        timeoutMs: PROBE_TIMEOUT_MS
      })
      if (result.code === 0) {
        return check('agents', `agent.${agent}`, 'pass', `${name} is installed and signed in.`)
      }
      // A CLI too old for the status verb also lands here, so this never fails the run.
      return check(
        'agents',
        `agent.${agent}`,
        'warn',
        result.timedOut
          ? `${name} is installed, but its sign-in check timed out.`
          : `${name} is installed but not signed in.`,
        { remediation: `Run \`${probe.signIn}\` in this environment.` }
      )
    })
  )
  if (others.length > 0) {
    const names = others.map((agent) => tuiAgentDisplayName(agent) ?? agent)
    checks.push(check('agents', 'agent.cli', 'pass', `Also installed: ${names.join(', ')}.`))
  }
  return checks
}

async function checkDisk(
  worktreePath: string,
  deps: EnvironmentDoctorDeps
): Promise<EnvironmentDoctorCheck[]> {
  const free = await deps.freeBytes(worktreePath).catch(() => null)
  if (free === null) {
    return [check('disk', 'disk.free', 'warn', 'Could not read free disk space.')]
  }
  const label = `${(free / GIB).toFixed(1)} GB free`
  if (free < DISK_FAIL_BYTES) {
    return [
      check('disk', 'disk.free', 'fail', `Only ${label}.`, {
        remediation: 'Grow the disk or clean caches; installs and builds will fail.'
      })
    ]
  }
  if (free < DISK_WARN_BYTES) {
    return [
      check('disk', 'disk.free', 'warn', `Only ${label}.`, {
        remediation: 'Consider a larger disk; dependency installs can need several GB.'
      })
    ]
  }
  return [check('disk', 'disk.free', 'pass', `${label}.`)]
}

function buildResult(
  worktreePath: string,
  checks: EnvironmentDoctorCheck[]
): EnvironmentDoctorResult {
  return { worktreePath, ok: checks.every((entry) => entry.status !== 'fail'), checks }
}
