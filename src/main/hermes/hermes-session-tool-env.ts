// Hermes runs every chat's tools in one gateway per profile. Orca's plugin there hands each tool the
// environment Orca wrote for its session (Hermes' per-session env hook, 0.23.1+), read at each spawn.
import { randomBytes } from 'node:crypto'
import { access, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { PublishSharedToolProcessSessionEnv } from '../runtime/agent-session/environment/shared-tool-process-session-env'
import { resolveHermesActiveProfileHome } from './hermes-default-home'
import {
  ensureHermesGatewayPluginCurrent,
  HERMES_SESSION_ENV_MINIMUM
} from './hermes-gateway-plugin-currency'
import { getConfigEnablement, parseHermesConfig } from './hermes-config-yaml'
import { inSessionFileTurn } from './hermes-session-file-queue'
import { SHARED_TOOL_PROCESS_BOT_FIELD } from '../../shared/agent-session/lifecycle/launch/agent-session-caller-env'
import { compareAppVersions } from '../../shared/app-lifecycle/identity/app-version'
import { AgentSessionAcquisitionRefusal } from '../native-chat/agent-session-wire/providers/structured-agent-session-adapter-errors'
import { AgentCliInstallationError } from '../native-chat/agent-launch/agent-cli-installation-error'
import {
  HERMES_PLUGIN_NAME,
  HERMES_SESSION_ENV_DIR,
  HERMES_SESSION_ID_PATTERN
} from './hermes-managed-plugin-source'

export const publishHermesSessionToolEnv: PublishSharedToolProcessSessionEnv = async ({
  env,
  providerSessionId,
  values,
  live,
  mustReach,
  agentVersion
}) => {
  if (!new RegExp(`^${HERMES_SESSION_ID_PATTERN}$`).test(providerSessionId)) {
    throw new Error('Hermes named its session with characters Orca does not write to a file name')
  }
  // The launch pins HERMES_HOME; a chat on the root follows its active profile, as Hermes does.
  const pinned = env.HERMES_HOME?.trim()
  const home = pinned ? await resolveHermesActiveProfileHome(pinned) : null
  const pluginDir = home ? join(home, 'plugins', HERMES_PLUGIN_NAME) : null
  // Without Orca's plugin loaded in this profile nothing reads the file; its tools keep no identity.
  const installed = home !== null && pluginDir !== null && (await pluginEnabled(home, pluginDir))
  if (mustReach) {
    assertBotToolsCanBeReached(installed, agentVersion)
  }
  if (!installed || !pluginDir || !home) {
    return async () => undefined
  }
  // Every chat heals a gateway that predates this build's plugin; only a bot's refuses to run without
  // it. A Hermes with no per-session env can't load it, so its chats never send a reload.
  const sessionEnvSupported =
    !agentVersion || compareAppVersions(agentVersion, HERMES_SESSION_ENV_MINIMUM) >= 0
  const gateway = sessionEnvSupported ? await ensureHermesGatewayPluginCurrent(home) : 'stale'
  if (mustReach && gateway !== 'current') {
    throw new AgentSessionAcquisitionRefusal(
      "Hermes' gateway runs an older Orca plugin and did not reload it.",
      'botToolsGatewayOutdated'
    )
  }
  const dir = join(home, HERMES_SESSION_ENV_DIR)
  const file = join(dir, `${providerSessionId}.json`)
  const publication = Symbol(providerSessionId)
  await inSessionFileTurn(file, async () => {
    // A child that exited while this waited must not replace a reopened chat's file.
    if (!live()) {
      return
    }
    await mkdir(dir, { recursive: true, mode: 0o700 })
    await writeStaged(file, mustReach ? { ...values, [BOT_MARK]: '1' } : values)
    owners.set(file, publication)
  })
  return () =>
    inSessionFileTurn(file, async () => {
      // A later child of the same conversation owns the file now.
      if (owners.get(file) !== publication) {
        return
      }
      owners.delete(file)
      // A bot's shell that outlives its chat must still be refused, not run as the owner.
      await (mustReach ? writeStaged(file, { [BOT_MARK]: '1' }) : rm(file, { force: true }))
    })
}

const BOT_MARK = SHARED_TOOL_PROCESS_BOT_FIELD

/** Renamed into place so a tool spawned meanwhile never reads half a file. */
async function writeStaged(file: string, values: Readonly<Record<string, string | null>>) {
  const staged = `${file}.${randomBytes(6).toString('hex')}.tmp`
  await writeFile(staged, JSON.stringify(values), { mode: 0o600 })
  await rename(staged, file)
}

/** A bot's tools carry its limits only through Orca's plugin, on a Hermes with per-session env,
 *  in a gateway that loaded this build's plugin (reloaded in place when it predates it). */
function assertBotToolsCanBeReached(installed: boolean, version: string | undefined): void {
  if (!installed) {
    throw new AgentSessionAcquisitionRefusal(
      "Hermes bots need Orca's agent status hooks for Hermes.",
      'botToolsNeedStatusHooks'
    )
  }
  if (version && compareAppVersions(version, HERMES_SESSION_ENV_MINIMUM) < 0) {
    throw AgentCliInstallationError.tooOld('hermes', {
      version,
      minimumVersion: HERMES_SESSION_ENV_MINIMUM
    })
  }
}

/** The plugin's files are there and the profile's config.yaml loads it (a disable unloads it). */
async function pluginEnabled(home: string, pluginDir: string): Promise<boolean> {
  const [files, config] = await Promise.all([
    access(join(pluginDir, '__init__.py')).then(
      () => true,
      () => false
    ),
    readFile(join(home, 'config.yaml'), 'utf-8').catch(() => null)
  ])
  const parsed = parseHermesConfig(config)
  const enablement = parsed.ok ? getConfigEnablement(parsed.config) : null
  return files && enablement !== null && enablement.enabled && !enablement.disabled
}

/** Each file's latest publication; files are written and removed only in this process. */
const owners = new Map<string, symbol>()
