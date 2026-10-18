// The pane identity a new PTY's env carries, stamped from the spawn's own ids, for both spawn lanes.

import { mkdirSync } from 'node:fs'
import {
  buildJcodeRuntimeDirEnv,
  JCODE_RUNTIME_DIR_ENV_KEY
} from '../../../shared/jcode-runtime-dir'
import { isTerminalLeafId, makePaneKey } from '../../../shared/stable-pane-id'
import { isValidTerminalTabId } from '../../../shared/terminal-tab-id'
import type { TuiAgent } from '../../../shared/tui-agent'
import { prewarmJcodeDaemon } from '../../jcode/daemon-prewarm'

export type PtySpawnPane = {
  paneKey: string
  tabId: string | undefined
  worktreeId: string | undefined
}

/** The pane a host spawn's own ids name, or null when they name none. */
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
  isDaemonHostSpawn: boolean
  launchAgent: TuiAgent | undefined
  cwd: string | undefined
  /** TEMPORARY (its own stacked PR removes it): only window daemon spawns pre-warm jcode. */
  prewarmsJcodeOnDaemonHost: boolean
}

export function stampPtySpawnPaneEnv(
  env: Record<string, string> | undefined,
  args: PtySpawnPaneEnvArgs
): void {
  if (!env) {
    return
  }
  const { pane } = args
  if (!pane) {
    // Why: ORCA_PANE_KEY crosses into shells/hook registries; only a key naming this spawn's own pane may reach it.
    delete env.ORCA_PANE_KEY
    delete env.ORCA_TAB_ID
    delete env.ORCA_WORKTREE_ID
    delete env.ORCA_AGENT_LAUNCH_TOKEN
    return
  }
  env.ORCA_PANE_KEY = pane.paneKey
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
  if (args.jcodeRuntimeDir === undefined) {
    return
  }
  env[JCODE_RUNTIME_DIR_ENV_KEY] = args.jcodeRuntimeDir
  // Why here too: daemon-host spawns never reach LocalPtyProvider.spawn, so
  // without this the pre-warm — the whole point of which is to beat jcode's
  // 5s socket budget on a cold runtime dir — would not fire for those panes.
  if (args.isDaemonHostSpawn && args.prewarmsJcodeOnDaemonHost) {
    prewarmJcodeDaemon({
      launchAgent: args.launchAgent,
      runtimeDir: args.jcodeRuntimeDir,
      cwd: args.cwd,
      env
    })
  }
}

/** Window local providers validate asynchronously; daemon spawns retain their synchronous preparation. */
export function selectWindowJcodeRuntimeDir(
  paneKey: string,
  isDaemonHostSpawn: boolean
): string | undefined {
  const runtimeDir = buildJcodeRuntimeDirEnv(paneKey)?.[JCODE_RUNTIME_DIR_ENV_KEY]
  if (runtimeDir === undefined) {
    return undefined
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
