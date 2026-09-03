import {
  ORCHESTRATION_COMPATIBILITY_ATTACHMENT_ENV,
  ORCHESTRATION_COMPATIBILITY_HOST_ID_ENV,
  ORCHESTRATION_COMPATIBILITY_HOST_INCARNATION_ENV,
  ORCHESTRATION_COMPATIBILITY_HOST_KIND_ENV
} from '../../shared/orchestration-compatibility-evidence'
import {
  SETUP_AGENT_SEQUENCE_STARTUP_COMMAND_ENV,
  SETUP_AGENT_SEQUENCE_STARTUP_SCRIPT_ENV
} from '../../shared/setup-agent-sequencing'
import { getShellReadyWrapperRoot } from '../providers/local-pty-shell-ready-wrapper-root'

const WSLENV_ENTRY_SEPARATOR = ':'

/**
 * Guest-side tree marker: stamped on every WSL session spawn and inherited
 * by all guest descendants. Daemon shutdown kills the marked guest tree
 * from inside the distro, which the Windows job object cannot reach.
 */
export const ORCA_PTY_TREE_ID_ENV = 'ORCA_PTY_TREE_ID'

/**
 * Whether a tree marker survives the guest-side fixed-string match. Control
 * characters would split the environ line the killer greps for, so they
 * disqualify the marker and callers degrade to Windows-side cleanup alone.
 */
export function isUsablePtyTreeMarker(value: string | undefined): value is string {
  if (!value || value.length === 0 || value.length > 512) {
    return false
  }
  // Why includes, not a character-class regex: control characters are
  // exactly what no-control-regex forbids matching, and only these three
  // can split the environ line the guest killer greps for.
  return !value.includes('\0') && !value.includes('\n') && !value.includes('\r')
}

/**
 * Stamp the guest tree marker for a WSL spawn. False (marker skipped) when
 * the id is missing or unusable — callers then degrade to Windows-side
 * cleanup alone. Session ids are renderer-influenced, so validate here.
 */
export function stampPtyTreeIdMarker(
  env: Record<string, string>,
  sessionId: string | undefined
): boolean {
  if (!isUsablePtyTreeMarker(sessionId)) {
    return false
  }
  env[ORCA_PTY_TREE_ID_ENV] = sessionId
  return true
}

function parseWslenvEntries(value: string | undefined): string[] {
  return value ? value.split(WSLENV_ENTRY_SEPARATOR).filter(Boolean) : []
}

function upsertWslenvEntry(entries: string[], entry: string): void {
  const variableName = entry.split('/')[0]
  const existingIndex = entries.findIndex((value) => value.split('/')[0] === variableName)
  if (existingIndex === -1) {
    entries.push(entry)
    return
  }
  entries[existingIndex] = entry
}

function applyWslenvPassthrough(
  env: Record<string, string | undefined>,
  passthroughEntries: string[]
): void {
  const entries = parseWslenvEntries(env.WSLENV)
  for (const entry of passthroughEntries) {
    const variableName = entry.split('/')[0]
    if (env[variableName]) {
      upsertWslenvEntry(entries, entry)
    }
  }
  env.WSLENV = entries.join(WSLENV_ENTRY_SEPARATOR)
}

function worktreeSetupWslenvEntries(env: Record<string, string | undefined>): string[] {
  return [
    // Setup/hook scripts read these (#9206). A pre-translated Linux value must
    // cross untranslated (/u); a raw C:\ path still needs WSLENV to convert it (/p).
    ...['ORCA_ROOT_PATH', 'ORCA_WORKTREE_PATH', 'CONDUCTOR_ROOT_PATH', 'GHOSTX_ROOT_PATH'].map(
      (name) => `${name}/${env[name]?.startsWith('/') ? 'u' : 'p'}`
    ),
    // A display name, never a path.
    'ORCA_WORKSPACE_NAME/u'
  ]
}

export function addOrcaWslInteropEnv(env: Record<string, string>): void {
  // Why set here: every WSL spawn path funnels through this helper, and the
  // in-guest login script needs the resolved wrapper root. Windows/WSL wrappers
  // are always the local file set -- windows-shell-args.ts is shared by the
  // in-process provider and the daemon spawner, so both resolve the same tree.
  env.ORCA_SHELL_READY_ROOT = getShellReadyWrapperRoot()
  // Why: the endpoint is a Windows path (/p-translated so the guest reads it
  // via /mnt/c) until the WSL hook relay reports the guest home — then it is
  // already a guest-side POSIX path and must cross untranslated.
  const endpointFlag = env.ORCA_AGENT_HOOK_ENDPOINT?.startsWith('/') ? 'u' : 'p'
  // Why: ONLY a guest-side POSIX overlay may cross. /p would path-translate a
  // Windows value into /mnt/c and let in-guest OpenCode adopt it as its config
  // root — reachable via the relay spawn's process.env (wsl-hook-relay-launch)
  // and via daemon-inherited env, which buildPtyHostEnv's delete cannot reach.
  const opencodeOverlayEntries = (['OPENCODE_CONFIG_DIR', 'ORCA_OPENCODE_CONFIG_DIR'] as const)
    .filter((name) => env[name]?.startsWith('/'))
    .map((name) => `${name}/u`)
  // Why: wsl.exe only imports selected Windows env vars, so WSL needs the wrapper root, pane identity, and hook/OMP coordinates at start.
  const passthroughEntries = [
    'ORCA_TERMINAL_HANDLE/u',
    // Why /u: the marker is an opaque id, never a path; the guest killer
    // matches it byte-for-byte, so translation would corrupt it.
    `${ORCA_PTY_TREE_ID_ENV}/u`,
    'ORCA_USER_DATA_PATH/p',
    // Why /p: the guest reads the content-addressed wrapper tree through /mnt/c,
    // and it cannot derive the hash segment from ORCA_USER_DATA_PATH alone.
    'ORCA_SHELL_READY_ROOT/p',
    'ORCA_CLI_COMMAND/u',
    'ORCA_CODEX_LAUNCH_PREFLIGHT/p',
    'ORCA_PANE_KEY/u',
    'ORCA_TAB_ID/u',
    'ORCA_WORKTREE_ID/u',
    'ORCA_AGENT_LAUNCH_TOKEN/u',
    `${SETUP_AGENT_SEQUENCE_STARTUP_COMMAND_ENV}/u`,
    `${SETUP_AGENT_SEQUENCE_STARTUP_SCRIPT_ENV}/u`,
    'ORCA_ORCHESTRATION_COMPATIBILITY_HOST_KIND/u',
    'ORCA_ORCHESTRATION_COMPATIBILITY_HOST_ID/u',
    'ORCA_ORCHESTRATION_COMPATIBILITY_HOST_INCARNATION/u',
    'ORCA_AGENT_HOOK_PORT/u',
    'ORCA_AGENT_HOOK_TOKEN/u',
    'ORCA_AGENT_HOOK_ENV/u',
    'ORCA_AGENT_HOOK_VERSION/u',
    'ORCA_AGENT_HOOK_TRANSPORT/u',
    `ORCA_AGENT_HOOK_ENDPOINT/${endpointFlag}`,
    ...opencodeOverlayEntries,
    'ORCA_WSL_HOOK_RELAY_VERSION/u',
    'ORCA_WSL_HOOK_INSTANCE/u',
    'ORCA_OMP_SOURCE_AGENT_DIR/p',
    'ORCA_OMP_STATUS_EXTENSION/p',
    ...worktreeSetupWslenvEntries(env)
  ]
  applyWslenvPassthrough(env, passthroughEntries)
}

export function stampWslOrchestrationCompatibilityHost(
  env: Record<string, string>,
  hostId: string | null | undefined,
  distro: string | null | undefined
): void {
  delete env[ORCHESTRATION_COMPATIBILITY_HOST_KIND_ENV]
  delete env[ORCHESTRATION_COMPATIBILITY_HOST_ID_ENV]
  delete env[ORCHESTRATION_COMPATIBILITY_HOST_INCARNATION_ENV]
  delete env[ORCHESTRATION_COMPATIBILITY_ATTACHMENT_ENV]
  const normalizedHostId = hostId?.trim()
  const normalizedDistro = distro?.trim()
  if (!normalizedHostId || !normalizedDistro) {
    return
  }
  env[ORCHESTRATION_COMPATIBILITY_HOST_KIND_ENV] = 'wsl'
  env[ORCHESTRATION_COMPATIBILITY_HOST_ID_ENV] = normalizedHostId
  env[ORCHESTRATION_COMPATIBILITY_HOST_INCARNATION_ENV] = normalizedDistro
}
