import { runProcess } from '@orca/process-host'
import { resolveCommandOnLocalPath } from '../ipc/command-path-resolver'
import { buildShellCommandFromArgv } from '../../shared/tui-agent-startup-shell'
import { loadTeamResource, resolveTeamPath, type ProjectTeamRole } from './project-team-config'

export async function buildTeamLaunch(
  role: ProjectTeamRole,
  config: string,
  root: string,
  contextFile: string
) {
  const shell = process.platform === 'win32' ? ('powershell' as const) : ('posix' as const)
  const cwd = resolveTeamPath(role.cwd, root)
  const env: Record<string, string> = {}
  const executable = role.provider
  if (role.provider === 'claude' && role.configHome) {
    env.CLAUDE_CONFIG_DIR = resolveTeamPath(role.configHome, root)
  }
  const binary = await resolveCommandOnLocalPath(executable, {
    cwd,
    env: { ...process.env, ...env }
  })
  if (!binary) {
    throw new Error(`team_cli_missing:${role.provider}`)
  }
  const prompt = `Initialize this role only. Read the instructions in ${contextFile}. Do not resume previous tasks, edit files, or delegate work. Reply TEAM_READY:${role.id} and wait for a new task.`
  let args: string[]
  if (role.provider === 'codex') {
    args = [
      '--no-daemon',
      '--cd',
      cwd,
      '--model',
      role.model,
      '-c',
      `model_reasoning_effort="${role.effort}"`
    ]
    if (role.codexSettings) {
      args.push(
        '-c',
        `model_auto_compact_token_limit=${role.codexSettings.model_auto_compact_token_limit}`,
        '-c',
        'model_auto_compact_token_limit_scope="total"'
      )
    }
  } else {
    if (!role.account || !role.configHome || !role.tools) {
      throw new Error('team_claude_account_or_tools_missing')
    }
    const status = await runProcess({
      program: binary,
      args: ['auth', 'status', '--json'],
      cwd,
      env: { ...process.env, ...env },
      timeoutMs: 15000
    })
    if (status.code !== 0 || status.timedOut) {
      throw new Error('team_auth_status_failed')
    }
    const auth: unknown = JSON.parse(status.stdout)
    if (
      !auth ||
      typeof auth !== 'object' ||
      !('loggedIn' in auth) ||
      auth.loggedIn !== true ||
      !('email' in auth) ||
      auth.email !== role.account
    ) {
      throw new Error('team_account_login_required')
    }
    args = [
      '--tools',
      role.tools,
      '--strict-mcp-config',
      '--permission-mode',
      role.permissionMode === 'manual' ? 'default' : role.permissionMode,
      '--model',
      role.model,
      '--effort',
      role.effort,
      '--name',
      role.title,
      '--append-system-prompt-file',
      contextFile
    ]
    if (role.pluginDir) {
      args.push('--plugin-dir', resolveTeamPath(role.pluginDir, root))
    }
    if (role.settingsFile) {
      const settings = await loadTeamResource(config, role.settingsFile)
      args.push('--settings', settings.path)
    }
    for (const scope of role.scopeDirs) {
      args.push('--add-dir', resolveTeamPath(scope, root))
    }
  }
  const base = buildShellCommandFromArgv([binary], shell)
  return {
    cwd,
    env,
    shell: process.platform === 'win32' ? ('powershell' as const) : undefined,
    command: buildShellCommandFromArgv([binary, ...args, prompt], shell),
    launchConfig: {
      agentCommand: base,
      agentArgs: buildShellCommandFromArgv(args, shell).replace(/^& /, ''),
      agentEnv: env
    }
  }
}
