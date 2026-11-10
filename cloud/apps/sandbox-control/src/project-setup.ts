// The repo's orca.yaml `scripts.setup` for workspaces nobody opens on a desktop first (API, CLI, phone,
// routines: `createWorkspace`). Those agents work in the VM's primary checkout, so no worktree create
// ever runs the setup hook there. A desktop-created cloud workspace is a linked worktree that orcad's
// worktree create sets up after the desktop's setup prompt, so the plain create route never calls this.
//
// Runs once per workspace (a marker under ~/.orca-sandbox, which the disk snapshot keeps across
// sleep), detached so a Worker never waits out a long install, with orcad's process env (managed
// ORCA_* names and the session's secrets) like the desktop's setup terminal. Skipped when the VM was
// booted from an org environment build: its install script already installed the dependencies.
// Log and exit code: ~/.orca-sandbox/project-setup/{setup.log,exit}.
//
// No setup prompt: nobody is there to answer it, and the caller chose this repo for this sandboxed VM,
// as unattended worktree creates run setup unless the project turned it off.
import { parseOrcaYaml } from '../../../../src/shared/orca-yaml'
import { PROJECT_ROOT } from './api/vm-agent'
import type { SandboxProviderApi } from './sandbox-provider'

/** `bash -c LAUNCHER orca-project-setup <setup script> <runner script>`: both are data, written to files. */
const LAUNCHER = String.raw`set -u
umask 077
P=${PROJECT_ROOT}
D="$HOME/.orca-sandbox/project-setup"
mkdir -p "$D"
# noclobber makes the marker an atomic claim: a retried create never starts a second run.
if ! (set -C; : >"$D/started") 2>/dev/null; then echo '{"state":"already"}'; exit 0; fi
common="$(git -C "$P" rev-parse --path-format=absolute --git-common-dir 2>/dev/null || true)"
if [ -n "$common" ] && [ -e "$common/orca-env-deps" ]; then
  echo 'orca: setup skipped: the environment build already installed dependencies' >"$D/setup.log"
  echo skipped >"$D/exit"
  echo '{"state":"skipped_environment_build"}'
  exit 0
fi
opid="$(cat "$HOME/.orca-sandbox/orcad.pid" 2>/dev/null || true)"
if [ -z "$opid" ] || [ ! -r "/proc/$opid/environ" ]; then
  rm -f "$D/started"
  echo '{"state":"no_orcad"}'
  exit 0
fi
printf '%s' "$1" >"$D/setup.sh"
printf '%s' "$2" >"$D/runner.sh"
setsid nohup bash "$D/runner.sh" "$D" "$opid" >"$D/setup.log" 2>&1 </dev/null &
echo $! >"$D/pid"
echo '{"state":"started"}'`

const RUNNER = String.raw`set -u
D="$1" opid="$2"
while IFS= read -r -d '' kv; do
  case "$kv" in [A-Za-z_]*=*) export "$kv" 2>/dev/null || true ;; esac
done <"/proc/$opid/environ"
export GIT_TERMINAL_PROMPT=0
cd ${PROJECT_ROOT} || { echo 'orca: no project checkout'; echo 2 >"$D/exit"; exit 0; }
echo "orca: running orca.yaml setup in $PWD at $(date -u +%Y-%m-%dT%H:%M:%SZ)"
code=0
timeout --kill-after=30 3600 bash "$D/setup.sh" </dev/null || code=$?
echo "orca: setup exited $code at $(date -u +%Y-%m-%dT%H:%M:%SZ)"
echo "$code" >"$D/exit.tmp" && mv "$D/exit.tmp" "$D/exit"`

const STATES = ['started', 'already', 'skipped_environment_build', 'no_orcad'] as const
export type ProjectSetupState = 'not_configured' | 'failed' | (typeof STATES)[number]

/** As the desktop's setup terminal runs it: bash, stopping at the first failing line. */
function runnerScript(script: string): string {
  return `#!/usr/bin/env bash\nset -e\n${script.replace(/\r\n/g, '\n')}\n`
}

/** Reads the checkout's orca.yaml with the desktop's parser and starts its setup script in the VM. */
export async function startProjectSetup(provider: SandboxProviderApi, sessionId: string): Promise<ProjectSetupState> {
  const yaml = await provider.readFile(sessionId, `${PROJECT_ROOT}/orca.yaml`)
  const script = yaml ? parseOrcaYaml(yaml)?.scripts.setup?.trim() : undefined
  if (!script) {
    return 'not_configured'
  }
  const result = await provider.runCommand(sessionId, {
    command: 'bash',
    args: ['-c', LAUNCHER, 'orca-project-setup', runnerScript(script), RUNNER],
    timeoutMs: 30_000
  })
  const state = /"state":"([a-z_]+)"/.exec(result.stdout)?.[1]
  return STATES.find((s) => s === state) ?? 'failed'
}

export const PROJECT_SETUP_SCRIPTS_FOR_TESTS = { LAUNCHER, RUNNER }
