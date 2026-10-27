import {
  ORCA_SCRUB_SAFE_PANE_ENV,
  ORCA_SCRUB_SAFE_LAUNCH_ENV
} from '../../shared/agent-hook-scrub-safe-env'
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
import { ORCA_IMAGE_PROTOCOL_ENV } from '../../shared/terminal-image-protocol'
import {
  RUNTIME_SOURCE_ID_ENV,
  RUNTIME_SOURCE_INCARNATION_ENV,
  RUNTIME_SOURCE_PROFILE_PATH_ENV
} from '../../shared/runtime-source-env'
import {
  CODEX_REMOTE_VIEWER_SSH_CONNECTION,
  PI_CLIPBOARD_OSC52_ENV
} from '../ipc/pty/host-env/remote-viewer-clipboard-env'

const WSLENV_ENTRY_SEPARATOR = ':'

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
    // Hooks need raw host paths translated (/p) and already-Linux paths unchanged (/u) (#9206).
    ...['ORCA_ROOT_PATH', 'ORCA_WORKTREE_PATH', 'CONDUCTOR_ROOT_PATH', 'GHOSTX_ROOT_PATH'].map(
      (name) => `${name}/${env[name]?.startsWith('/') ? 'u' : 'p'}`
    ),
    // A display name, never a path.
    'ORCA_WORKSPACE_NAME/u'
  ]
}

/** Adds the host environment values required by a WSL PTY and its guest relay. */
export function addOrcaWslInteropEnv(env: Record<string, string>): void {
  // Local and daemon WSL spawns resolve the same content-addressed host wrapper tree.
  env.ORCA_SHELL_READY_ROOT = getShellReadyWrapperRoot()
  // The hook endpoint starts as a host path; guest relay discovery can replace it with an already-Linux path.
  const endpointFlag = env.ORCA_AGENT_HOOK_ENDPOINT?.startsWith('/') ? 'u' : 'p'
  // Only guest overlays may cross; translating inherited Windows overlays would make OpenCode adopt host config.
  const opencodeOverlayEntries = (['OPENCODE_CONFIG_DIR', 'ORCA_OPENCODE_CONFIG_DIR'] as const)
    .filter((name) => env[name]?.startsWith('/'))
    .map((name) => `${name}/u`)
  // wsl.exe imports only selected variables; publish pane identity and hook/wrapper coordinates.
  const passthroughEntries = [
    'ORCA_TERMINAL_HANDLE/u',
    'ORCA_USER_DATA_PATH/p',
    // Guests cannot derive the content hash; translate the resolved host wrapper root.
    'ORCA_SHELL_READY_ROOT/p',
    'ORCA_CLI_COMMAND/u',
    // Managed launcher lives in host userData.
    'ORCA_WSL_CLI_DIR/p',
    'ORCA_CODEX_LAUNCH_PREFLIGHT/p',
    'ORCA_CODEX_ISOLATE/u',
    'ORCA_PANE_KEY/u',
    `${ORCA_SCRUB_SAFE_PANE_ENV}/u`,
    'ORCA_TAB_ID/u',
    'ORCA_WORKTREE_ID/u',
    // Workspace identity must remain untranslated.
    'ORCA_WORKSPACE_ID/u',
    'ORCA_AGENT_LAUNCH_TOKEN/u',
    `${ORCA_SCRUB_SAFE_LAUNCH_ENV}/u`,
    // Select the pane-owning OpenCode variant when native and WSL installs coexist.
    'ORCA_OPENCODE_AGENT/u',
    `${SETUP_AGENT_SEQUENCE_STARTUP_COMMAND_ENV}/u`,
    `${SETUP_AGENT_SEQUENCE_STARTUP_SCRIPT_ENV}/u`,
    'ORCA_ORCHESTRATION_COMPATIBILITY_HOST_KIND/u',
    'ORCA_ORCHESTRATION_COMPATIBILITY_HOST_ID/u',
    'ORCA_ORCHESTRATION_COMPATIBILITY_HOST_INCARNATION/u',
    `${RUNTIME_SOURCE_ID_ENV}/u`,
    `${RUNTIME_SOURCE_INCARNATION_ENV}/u`,
    // Compare with the host CLI's userData path, never a translated guest path.
    `${RUNTIME_SOURCE_PROFILE_PATH_ENV}/u`,
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
    `ORCA_OMP_STATUS_EXTENSION/${env.ORCA_OMP_STATUS_EXTENSION?.startsWith('/') ? 'u' : 'p'}`,
    ...(env.ORCA_PI_SOURCE_AGENT_DIR?.startsWith('/') ? ['ORCA_PI_SOURCE_AGENT_DIR/u'] : []),
    `${ORCA_IMAGE_PROTOCOL_ENV}/u`,
    'CLAUDE_CODE_FORCE_TERMINAL_IMAGES/u',
    ...(env.ORCA_CLAUDE_AGENT_VIEW_PLUGIN_DIR?.startsWith('/')
      ? ['ORCA_CLAUDE_AGENT_VIEW_PLUGIN_DIR/u', 'ORCA_CLAUDE_CONFIG_DIR/u']
      : []),
    // Forward only Orca's clipboard marker; a host SSH session must not leak into bare guest shells.
    ...(env.SSH_CONNECTION === CODEX_REMOTE_VIEWER_SSH_CONNECTION ? ['SSH_CONNECTION/u'] : []),
    `${PI_CLIPBOARD_OSC52_ENV}/u`,
    'ORCA_OMP_FRESH_CONFIG/p',
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
