import { isAbsolute, win32 } from 'node:path'
import { runProcess } from '@orca/process-host'
import {
  quoteStartupArg,
  tokenizeStartupCommand
} from '../../../shared/agent-launch/startup/tui-agent-startup-shell'
import { resolveLocalWindowsAgentStartupShell } from '../../../shared/windows-terminal-shell'
import { resolveCommandOnLocalPath } from '../../ipc/command-path/command-path-resolver'

export async function pinCodexResumeProviderLaunch(args: {
  command: string | undefined
  sessionId: string
  modelProvider: string
  codexHomePath: string
  shellOverride: string | undefined
  env: NodeJS.ProcessEnv | undefined
  cwd: string | undefined
}): Promise<string> {
  const refuse = (): never => {
    throw new Error(
      'Codex resume stopped: this launch cannot safely select the saved model provider'
    )
  }
  const command = args.command
  if (!command || !/^[A-Za-z0-9_.-]+$/.test(args.modelProvider)) {
    return refuse()
  }
  const shell =
    resolveLocalWindowsAgentStartupShell({
      platform: process.platform,
      isRemote: false,
      terminalWindowsShell: args.shellOverride
    }) ?? 'posix'
  const parsed = tokenizeStartupCommand(command, shell)
  if (!parsed.ok) {
    return refuse()
  }
  const executableIndex = shell === 'powershell' && parsed.tokens[0] === '&' ? 1 : 0
  const executable = parsed.tokens[executableIndex]
  // cmd preserves single quotes; the identifier allowlist makes this a literal TOML string.
  const providerArg =
    shell === 'cmd'
      ? `model_provider='${args.modelProvider}'`
      : quoteStartupArg(`model_provider=${JSON.stringify(args.modelProvider)}`, shell)
  if (
    !executable ||
    !/^codex(\.(exe|cmd|bat|ps1))?$/i.test(win32.basename(executable)) ||
    parsed.spans.some(
      (span, index) =>
        span.divergesFromShell &&
        index !== executableIndex - 1 &&
        !(
          shell === 'cmd' &&
          parsed.tokens[index - 1] === '-c' &&
          command.slice(span.start, span.end) === providerArg
        )
    ) ||
    parsed.tokens.some(
      (token) =>
        token === '--' ||
        token === '--%' ||
        token === '--oss' ||
        /^--(?:local-provider|remote|remote-auth-token-env)(?:=|$)/.test(token)
    )
  ) {
    return refuse()
  }
  for (let index = 1; index < parsed.spans.length; index += 1) {
    if (!/^[ \t]+$/.test(command.slice(parsed.spans[index - 1].end, parsed.spans[index].start))) {
      return refuse()
    }
  }
  const resumeSpan = parsed.spans.at(-2)
  if (!resumeSpan || parsed.tokens.at(-2) !== 'resume' || parsed.tokens.at(-1) !== args.sessionId) {
    return refuse()
  }
  const originalBase = command.slice(0, resumeSpan.start).trimEnd()
  const env = { ...process.env, ...args.env, CODEX_HOME: args.codexHomePath }
  const program = isAbsolute(executable)
    ? executable
    : await resolveCommandOnLocalPath(executable, { env, cwd: args.cwd })
  if (!program) {
    return refuse()
  }
  try {
    const help = await runProcess({
      program,
      args: ['resume', '--help'],
      env,
      cwd: args.cwd,
      timeoutMs: 5_000
    })
    if (!help.stdout.includes('--config')) {
      return refuse()
    }
  } catch {
    return refuse()
  }
  // Last CLI config wins over profiles and user defaults without rewriting either.
  const override = ` -c ${providerArg}`
  const base = originalBase.endsWith(override) ? originalBase : `${originalBase}${override}`
  return `${base}${command.trimEnd().slice(originalBase.length)}`
}
