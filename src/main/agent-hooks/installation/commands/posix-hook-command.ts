import { quotePosixShell } from '../../../../shared/shell/launch/shell-argument-quoting'
import {
  POSIX_HOOK_STDIN_BACKGROUND_DRAIN_COMMAND,
  POSIX_HOOK_STDIN_DRAIN_COMMAND
} from '../scripts/hook-stdin-contract'

// Missing scripts must become silent no-ops rather than fail every tool call.
export function wrapPosixHookCommand(
  scriptPath: string,
  env: Record<string, string> = {},
  // Gate events treat silence as denial, so missing scripts may need fallback stdout.
  options: { fallbackStdout?: string; requiredEnvVar?: string; stdinMayStayOpen?: boolean } = {}
): string {
  // Keep arbitrary paths literal across shell metacharacters.
  const quoted = quotePosixShell(scriptPath)
  const envPrefix = Object.entries(env)
    .map(([key, value]) => `${key}=${quotePosixShell(value)}`)
    .join(' ')
  const invocation = envPrefix ? `${envPrefix} /bin/sh ${quoted}` : `/bin/sh ${quoted}`
  const drain = options.stdinMayStayOpen
    ? POSIX_HOOK_STDIN_BACKGROUND_DRAIN_COMMAND
    : POSIX_HOOK_STDIN_DRAIN_COMMAND
  const fallback =
    options.fallbackStdout === undefined
      ? drain
      : `printf '%s\\n' ${quotePosixShell(options.fallbackStdout)}; ${drain}`
  // Default-form variables survive Grok prechecks and defer environment reads to invocation.
  const guards = [
    ...(options.requiredEnvVar ? [`[ -n "\${${options.requiredEnvVar}-}" ]`] : []),
    `[ -f ${quoted} ]`,
    `[ -r ${quoted} ]`,
    `[ -x ${quoted} ]`
  ].join(' && ')
  return `if ${guards}; then ${invocation}; else ${fallback}; fi`
}
