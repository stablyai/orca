import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { SFTPWrapper } from 'ssh2'
import type { AgentHookInstallState, AgentHookInstallStatus } from '../../shared/agent-hook-types'
import { resolveGrokHomeDir } from '../../shared/grok-session-paths'
import {
  getSharedManagedScriptPath,
  readHooksJson,
  readHooksJsonWithRaw,
  wrapPosixHookCommand,
  wrapWindowsCmdHookCommand,
  writeHooksJson,
  writeManagedScript
} from '../agent-hooks/installer-utils'
import { refreshManagedScriptIfPresent } from '../agent-hooks/managed-hook-script-refresh'
import { buildPosixHookPayloadCapture } from '../agent-hooks/hook-stdin-contract'
import {
  buildWindowsGrokHookScript,
  GROK_HOME_ENVELOPE_MAX_LENGTH
} from './windows-grok-hook-script'
import { isOrcaOwnedRemnant, removeManagedGrokHookEntries } from './grok-hook-config-cleanup'
import { buildInstalledGrokConfig, GROK_EVENTS, GROK_TOOL_EVENT_MATCHER } from './grok-hook-config'
import { installRemoteGrokHook, removeRemoteGrokHook } from './grok-hook-remote-mutations'
import {
  readGrokHookConfigSnapshot,
  removeGrokHookConfigIfUnchanged,
  writeGrokHookConfigIfUnchanged
} from './grok-hook-config-file'
import {
  claimGrokHookSession,
  clearGrokHookSessionOwners,
  readLiveGrokHookSessionOwners,
  releaseGrokHookSession
} from './grok-hook-session-owner'

// Why: Grok's tool-event matcher is a real regex (see Grok hooks docs). Bare
// `*` is not a valid "match all" pattern and can fail to load/match, so tool
// lifecycle hooks never fire. `.*` matches every tool name (same as Command
// Code's managed hooks).
/** Test seam: the matcher string written for Pre/Post tool lifecycle hooks. */
export function getGrokToolEventMatcherForTests(): string {
  return GROK_TOOL_EVENT_MATCHER
}

function getConfigPath(): string {
  // Why: Grok loads trusted global hook files from $GROK_HOME/hooks/*.json
  // (or ~/.grok when unset). Honor GROK_HOME so install/status match the same
  // home Grok and transcript lookup use; keep Orca entries in a dedicated file
  // so user-authored hook files stay untouched.
  return join(resolveGrokHomeDir(), 'hooks', 'orca-status.json')
}

function getSessionOwnerPath(): string {
  const configKey = createHash('sha256').update(getConfigPath()).digest('hex').slice(0, 16)
  return getSharedManagedScriptPath(`grok-status-owners-${configKey}.json`)
}

function getManagedScriptFileName(): string {
  return process.platform === 'win32' ? 'grok-hook.cmd' : 'grok-hook.sh'
}

function getManagedScriptPath(): string {
  return getSharedManagedScriptPath(getManagedScriptFileName())
}

function getManagedCommand(scriptPath: string): string {
  // Why (#14828): Grok runs a hook command containing a space as `pwsh -Command <cmd>`, so the
  // encoded PowerShell launcher cost two interpreters before reaching the script —
  // `grok.exe -> pwsh.exe -> powershell.exe -> cmd.exe`, ~610ms per event, and the agent's hook
  // console stays up for all of it. A cmd-safe bare path is spawned directly
  // (`grok.exe -> cmd.exe`, ~110ms), the same shape Codex/Devin/Antigravity already register
  // (#8430). Paths that are not cmd-safe still fall back to the encoded launcher (#6078).
  // Tradeoff, as for those agents: a bare path cannot carry the launcher's missing-script
  // guard, so a deleted script surfaces as a per-event `command not found` in the agent's log
  // instead of a silent drain. Grok fails open — the tool still runs, including on PreToolUse.
  return process.platform === 'win32'
    ? wrapWindowsCmdHookCommand(scriptPath)
    : wrapPosixHookCommand(scriptPath)
}

/** Test seam: the command registered for `scriptPath` on the current platform. */
export function getManagedCommandForTests(scriptPath: string): string {
  return getManagedCommand(scriptPath)
}

function getManagedScript(target: 'local' | 'posix' = 'local'): string {
  if (target === 'local' && process.platform === 'win32') {
    return buildWindowsGrokHookScript()
  }

  return [
    '#!/bin/sh',
    ...buildPosixHookPayloadCapture(),
    'if [ -n "$ORCA_AGENT_HOOK_ENDPOINT" ] && [ -r "$ORCA_AGENT_HOOK_ENDPOINT" ]; then',
    '  . "$ORCA_AGENT_HOOK_ENDPOINT" 2>/dev/null || :',
    'fi',
    'if [ -z "$ORCA_AGENT_HOOK_PORT" ] || [ -z "$ORCA_AGENT_HOOK_TOKEN" ] || [ -z "$ORCA_PANE_KEY" ]; then',
    '  exit 0',
    'fi',
    'grok_home=',
    `if [ -n "\${GROK_HOME:-}" ] && [ "\${#GROK_HOME}" -le ${GROK_HOME_ENVELOPE_MAX_LENGTH} ]; then`,
    '  grok_home=$GROK_HOME',
    'fi',
    // Timeout caps best-effort hook posts if the local listener stalls.
    // Why: pipe payload to curl's stdin (`payload@-`) instead of an inline
    // `payload=$VALUE` arg, so tens-of-KB tool output stays off the curl
    // command line (EDR command-line false positives). Wire body is identical.
    'printf \'%s\' "$payload" | curl -sS -X POST "http://127.0.0.1:${ORCA_AGENT_HOOK_PORT}/hook/grok" \\',
    '  --connect-timeout 0.5 --max-time 1.5 \\',
    '  -H "Content-Type: application/x-www-form-urlencoded" \\',
    '  -H "X-Orca-Agent-Hook-Token: ${ORCA_AGENT_HOOK_TOKEN}" \\',
    '  --data-urlencode "paneKey=${ORCA_PANE_KEY}" \\',
    '  --data-urlencode "tabId=${ORCA_TAB_ID}" \\',
    '  --data-urlencode "launchToken=${ORCA_AGENT_LAUNCH_TOKEN}" \\',
    '  --data-urlencode "worktreeId=${ORCA_WORKTREE_ID}" \\',
    '  --data-urlencode "env=${ORCA_AGENT_HOOK_ENV}" \\',
    '  --data-urlencode "version=${ORCA_AGENT_HOOK_VERSION}" \\',
    '  --data-urlencode "grokHome=${grok_home}" \\',
    '  --data-urlencode "payload@-" >/dev/null 2>&1 || true',
    'exit 0',
    ''
  ].join('\n')
}

function readGrokHookConfigRawSync(configPath: string): string | null {
  try {
    return readFileSync(configPath, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return null
    }
    throw error
  }
}

function notInstalledStatus(
  configPath: string,
  detail: string | null = null
): AgentHookInstallStatus {
  return {
    agent: 'grok',
    state: detail ? 'error' : 'not_installed',
    configPath,
    managedHooksPresent: false,
    detail
  }
}

export class GrokHookService {
  async refreshManagedScripts(): Promise<void> {
    await refreshManagedScriptIfPresent(getManagedScriptPath(), getManagedScript())
  }

  getStatus(): AgentHookInstallStatus {
    const configPath = getConfigPath()
    const scriptPath = getManagedScriptPath()
    const config = readHooksJson(configPath)
    if (!config) {
      return {
        agent: 'grok',
        state: 'error',
        configPath,
        managedHooksPresent: false,
        detail: 'Could not parse Grok hook config'
      }
    }

    const command = getManagedCommand(scriptPath)
    const missing: string[] = []
    let presentCount = 0
    for (const event of GROK_EVENTS) {
      const definitions = Array.isArray(config.hooks?.[event.eventName])
        ? config.hooks![event.eventName]!
        : []
      const hasCommand = definitions.some((definition) =>
        (definition.hooks ?? []).some((hook) => hook.command === command)
      )
      if (hasCommand) {
        presentCount += 1
      } else {
        missing.push(event.eventName)
      }
    }

    const managedHooksPresent = presentCount > 0
    let state: AgentHookInstallState
    let detail: string | null
    if (missing.length === 0) {
      state = 'installed'
      detail = null
    } else if (presentCount === 0) {
      state = 'not_installed'
      detail = null
    } else {
      state = 'partial'
      detail = `Managed hook missing for events: ${missing.join(', ')}`
    }
    return { agent: 'grok', state, configPath, managedHooksPresent, detail }
  }

  install(options?: { userInitiated?: boolean }): AgentHookInstallStatus {
    const configPath = getConfigPath()
    const scriptPath = getManagedScriptPath()
    const snapshot = readHooksJsonWithRaw(configPath)
    const config = snapshot.config
    if (!config) {
      return {
        agent: 'grok',
        state: 'error',
        configPath,
        managedHooksPresent: false,
        detail: 'Could not parse Grok hook config'
      }
    }

    // Why: an existing empty file is an explicit user choice, not a missing config -- the reported
    // workaround for #15518 was emptying it by hand. Why userInitiated overrides: turning the
    // setting back on is an equally explicit choice, and the later one. Without this the toggle
    // silently does nothing forever and the only way back is deleting a file in a hidden directory.
    if (
      options?.userInitiated !== true &&
      snapshot.raw !== null &&
      Object.keys(config.hooks ?? {}).length === 0
    ) {
      return this.getStatus()
    }

    buildInstalledGrokConfig(config, getManagedCommand(scriptPath), getManagedScriptFileName())
    writeManagedScript(scriptPath, getManagedScript())
    mkdirSync(dirname(configPath), { recursive: true })
    if (readGrokHookConfigRawSync(configPath) !== snapshot.raw) {
      return notInstalledStatus(configPath, 'Grok hook config changed during installation')
    }
    writeHooksJson(configPath, config)
    return this.getStatus()
  }

  async installRemote(
    sftp: SFTPWrapper,
    remoteHome: string,
    remoteGrokHome?: string
  ): Promise<AgentHookInstallStatus> {
    return await installRemoteGrokHook(sftp, remoteHome, remoteGrokHome, getManagedScript('posix'))
  }

  async removeRemote(
    sftp: SFTPWrapper,
    remoteHome: string,
    remoteGrokHome?: string
  ): Promise<AgentHookInstallStatus> {
    return await removeRemoteGrokHook(sftp, remoteHome, remoteGrokHome)
  }

  remove(): AgentHookInstallStatus {
    const configPath = getConfigPath()
    const snapshot = readHooksJsonWithRaw(configPath)
    const config = snapshot.config
    if (!config) {
      return notInstalledStatus(configPath, 'Could not parse Grok hook config')
    }
    if (snapshot.raw === null) {
      return notInstalledStatus(configPath)
    }
    const cleanup = removeManagedGrokHookEntries(config, getManagedScriptFileName())
    if (!cleanup.removedAny) {
      return notInstalledStatus(configPath)
    }
    if (readGrokHookConfigRawSync(configPath) !== snapshot.raw) {
      return notInstalledStatus(configPath, 'Grok hook config changed during cleanup')
    }
    if (isOrcaOwnedRemnant(cleanup.config)) {
      rmSync(configPath, { force: true })
    } else {
      writeHooksJson(configPath, cleanup.config)
    }
    // Why unconditional: this is the explicit "turn agent status hooks off" action, so it removes
    // what Orca installed regardless of other live instances, and the record must not outlive it.
    rmSync(getSessionOwnerPath(), { force: true })
    return notInstalledStatus(configPath)
  }

  /**
   * Startup reconciliation. Removes a hook config stranded by a previous Orca that never reached
   * its quit path, so a crash does not leave Grok loading Orca's hooks forever (#15518). A config
   * owned by a still-live Orca is left alone.
   */
  async reconcileAfterUncleanExit(): Promise<void> {
    const ownersPath = getSessionOwnerPath()
    if ((await readLiveGrokHookSessionOwners(ownersPath)).length > 0) {
      return
    }
    // Why surfaced: removeAsync reports failure as a status, not a throw, so a stranded config that
    // cannot be cleaned would otherwise be invisible -- and this path exists precisely to catch the
    // case the user already reported.
    const status = await this.removeAsync({ force: true })
    if (status.detail) {
      console.warn(`[agent-hooks] Grok hook reconciliation after unclean exit: ${status.detail}`)
    }
    await clearGrokHookSessionOwners(ownersPath)
  }

  /**
   * Claims the installed config for this process so the next launch can detect an unclean exit.
   * Why it does not overwrite a live owner: two Orcas can share one $GROK_HOME (packaged and dev
   * do not share the single-instance lock). If a later starter took the record and then crashed,
   * the next launch would read that dead owner and remove the config the FIRST, still-running
   * Orca is using. Keeping the earliest live claimant means a stale record always implies every
   * recorded owner is gone.
   */
  async claimSession(): Promise<void> {
    if (!this.getStatus().managedHooksPresent) {
      return
    }
    await claimGrokHookSession(getSessionOwnerPath())
  }

  /**
   * Quit-path removal. Why it consults the ownership record: two Orcas can share one $GROK_HOME,
   * and without this the first one to quit deletes the config every other live instance is using.
   * `force` skips the check for startup reconciliation, where every recorded owner is already gone.
   */
  async removeAsync(options?: { force?: boolean }): Promise<AgentHookInstallStatus> {
    const configPath = getConfigPath()
    if (options?.force !== true) {
      const lastOwner = await releaseGrokHookSession(getSessionOwnerPath())
      if (!lastOwner) {
        return notInstalledStatus(configPath)
      }
    }
    const snapshot = await readGrokHookConfigSnapshot(configPath)
    if (!snapshot.config) {
      return notInstalledStatus(configPath, 'Could not parse Grok hook config')
    }
    if (snapshot.raw === null) {
      return notInstalledStatus(configPath)
    }
    const cleanup = removeManagedGrokHookEntries(snapshot.config, getManagedScriptFileName())
    if (!cleanup.removedAny) {
      return notInstalledStatus(configPath)
    }
    const updated = isOrcaOwnedRemnant(cleanup.config)
      ? await removeGrokHookConfigIfUnchanged(configPath, snapshot.raw)
      : await writeGrokHookConfigIfUnchanged(
          configPath,
          snapshot.raw,
          `${JSON.stringify(cleanup.config, null, 2)}\n`
        )
    return updated
      ? notInstalledStatus(configPath)
      : notInstalledStatus(configPath, 'Grok hook config changed during cleanup')
  }
}

export const grokHookService = new GrokHookService()
