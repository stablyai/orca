import { mkdirSync } from 'node:fs'
import { isAbsolute } from 'node:path'
import {
  buildJcodeRuntimeDirEnv,
  JCODE_RUNTIME_DIR_ENV_KEY
} from '../../../shared/jcode-runtime-dir'
import { applyScrubSafeAgentEnvAliases } from '../../../shared/agent-hook-scrub-safe-env'
import { isTerminalLeafId, makePaneKey } from '../../../shared/stable-pane-id'
import { isValidTerminalTabId } from '../../../shared/terminal-tab-id'
import {
  JCODE_PANE_SECRET_ENV_KEY,
  JCODE_SPAWN_HOOK_ENV_KEY
} from '../../../shared/jcode-spawn-hook'
import { forgetJcodePaneSecret, mintJcodePaneSecret } from '../../jcode/jcode-pane-secrets'

export type PtySpawnPane = {
  paneKey: string
  tabId: string | undefined
  worktreeId: string | undefined
}

export function ptySpawnPaneFromIds(ids: {
  tabId?: string
  leafId?: string
  worktreeId?: string
}): PtySpawnPane | null {
  const { tabId, leafId } = ids
  if (
    typeof tabId !== 'string' ||
    !isValidTerminalTabId(tabId) ||
    typeof leafId !== 'string' ||
    !isTerminalLeafId(leafId)
  ) {
    return null
  }
  return { paneKey: makePaneKey(tabId, leafId), tabId, worktreeId: ids.worktreeId }
}

type PtySpawnPaneEnvArgs = {
  /** Null when the spawn's own tab+leaf ids don't name a valid pane. */
  pane: PtySpawnPane | null
  jcodeRuntimeDir: string | undefined
  jcodeSpawnHook?: string
}

export function stampPtySpawnPaneEnv(
  env: Record<string, string> | undefined,
  args: PtySpawnPaneEnvArgs
): void {
  if (!env) {
    return
  }
  const { pane } = args
  delete env[JCODE_PANE_SECRET_ENV_KEY]
  if (!pane) {
    // Shell/hook identity must name this spawn's own pane, never an unproved renderer key.
    delete env.ORCA_PANE_KEY
    delete env.ORCA_TAB_ID
    delete env.ORCA_WORKTREE_ID
    delete env.ORCA_AGENT_LAUNCH_TOKEN
    applyScrubSafeAgentEnvAliases(env)
    return
  }
  env.ORCA_PANE_KEY = pane.paneKey
  forgetJcodePaneSecret(pane.paneKey)
  if (args.jcodeSpawnHook !== undefined && !Object.hasOwn(env, JCODE_SPAWN_HOOK_ENV_KEY)) {
    env[JCODE_SPAWN_HOOK_ENV_KEY] = args.jcodeSpawnHook
    env[JCODE_PANE_SECRET_ENV_KEY] = mintJcodePaneSecret(pane.paneKey)
  }
  if (pane.tabId !== undefined) {
    env.ORCA_TAB_ID = pane.tabId
  } else {
    delete env.ORCA_TAB_ID
  }
  if (pane.worktreeId !== undefined) {
    env.ORCA_WORKTREE_ID = pane.worktreeId
  } else {
    delete env.ORCA_WORKTREE_ID
  }
  // A failed managed-dir preparation must leave a working caller directory intact.
  if (args.jcodeRuntimeDir !== undefined) {
    env[JCODE_RUNTIME_DIR_ENV_KEY] = args.jcodeRuntimeDir
  }
  // Why: SSH relay spawns skip the local/daemon env builders that otherwise mirror these.
  applyScrubSafeAgentEnvAliases(env)
}

export function validateJcodeRuntimeDirOverride(
  runtimeDir: string | undefined
): string | undefined {
  if (
    runtimeDir !== undefined &&
    (typeof runtimeDir !== 'string' ||
      runtimeDir.length > 4096 ||
      runtimeDir.includes('\0') ||
      !isAbsolute(runtimeDir))
  ) {
    throw new Error('Invalid jcode runtime dir override')
  }
  return runtimeDir
}

/** Window local providers validate asynchronously; daemon spawns retain their synchronous preparation. */
export function selectWindowJcodeRuntimeDir(
  paneKey: string,
  isDaemonHostSpawn: boolean,
  override?: string
): string | undefined {
  const validatedOverride = validateJcodeRuntimeDirOverride(override)
  const runtimeDir = buildJcodeRuntimeDirEnv(paneKey)?.[JCODE_RUNTIME_DIR_ENV_KEY]
  if (runtimeDir === undefined) {
    return undefined
  }
  if (validatedOverride !== undefined) {
    return validatedOverride
  }
  if (isDaemonHostSpawn) {
    try {
      mkdirSync(runtimeDir, { recursive: true })
    } catch {
      // Directory failure must not prevent an ordinary shell from opening.
      return undefined
    }
  }
  return runtimeDir
}
