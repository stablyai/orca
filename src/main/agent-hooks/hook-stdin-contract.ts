export type PosixHookEmptyPayloadPolicy = 'exit' | 'empty-object'

// Why: a stripped PATH must not stop a hook from consuming stdin, or the agent
// sees exit 127 and a broken pipe mid-write (#8110). `command -p` resolves from
// the shell's built-in default PATH, so it also survives hosts without /bin/cat
// (NixOS) and ignores a worktree-local `cat` that could capture the payload.
export const POSIX_HOOK_STDIN_READER = '{ command -p cat 2>/dev/null || cat; }'
export const POSIX_HOOK_STDIN_DRAIN_COMMAND = `${POSIX_HOOK_STDIN_READER} >/dev/null 2>&1 || :`

// Why: every POSIX hook must own stdin before any no-op exit; sharing this
// prelude prevents agent templates from inventing different drain semantics.
export function buildPosixHookPayloadCapture(
  emptyPayloadPolicy: PosixHookEmptyPayloadPolicy = 'exit'
): string[] {
  const emptyPayloadLines =
    emptyPayloadPolicy === 'empty-object' ? ["  payload='{}'"] : ['  exit 0']
  return [
    `payload=$(${POSIX_HOOK_STDIN_READER})`,
    'if [ -z "$payload" ]; then',
    ...emptyPayloadLines,
    'fi'
  ]
}

export const WINDOWS_HOOK_STDIN_DRAIN_LABEL = 'orca_agent_hook_drain_stdin'
// Why: qualify the stdin reader because Windows searches the worktree for
// executables before PATH and hook payloads must not reach repo-local code.
export const WINDOWS_HOOK_STDIN_READER = '"%SystemRoot%\\System32\\more.com"'
export const WINDOWS_HOOK_STDIN_DRAIN_COMMAND = `${WINDOWS_HOOK_STDIN_READER} >nul 2>nul`

// Why: these guards deliberately exit instead of draining, walking back part of #8430.
// #8430 did cover callers without Orca env, but it assumed every caller eventually closes
// stdin. A non-Orca caller need not, and more.com then blocks forever: an immortal
// cmd.exe/more.com pair plus a console window on every hook event (#11549). A transient
// broken pipe on a caller that would never close stdin is the cheaper of the two failures.
// Orca-invoked hooks keep the #8430 guarantee — their env is set, so they fall through to
// the post command, which reads stdin to EOF.
export function buildWindowsHookEnvironmentGuardLines(): string[] {
  return [
    'if "%ORCA_AGENT_HOOK_PORT%"=="" exit /b 0',
    'if "%ORCA_AGENT_HOOK_TOKEN%"=="" exit /b 0',
    'if "%ORCA_PANE_KEY%"=="" exit /b 0'
  ]
}

export function buildWindowsHookStdinDrainEpilogue(): string[] {
  return [`:${WINDOWS_HOOK_STDIN_DRAIN_LABEL}`, WINDOWS_HOOK_STDIN_DRAIN_COMMAND, 'exit /b 0']
}
