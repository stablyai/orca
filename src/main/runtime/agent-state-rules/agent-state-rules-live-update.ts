import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { getAppEnvironment } from '../../../shared/app-environment'
import { readFetchResponseTextWithinLimit } from '../../../shared/fetch-response-body'
import type { GlobalSettings } from '../../../shared/global-settings-types'
import { getVersionChannel, MAIN_RELEASE_REPO } from '../../../shared/release-channel'
import { getMainHttpClient } from '../../network/http-client'
import { writePluginFileAtomically } from '../../plugins/plugin-atomic-file-write'
import {
  activateAgentStateRules,
  BUNDLED_AGENT_STATE_RULES,
  getActiveAgentStateRules,
  overlayOnBundledAgentStateRules,
  type ActiveAgentStateRules,
  type AgentStateRulesSource
} from './active-agent-state-rules'
import {
  AGENT_STATE_RULES_BUNDLE_MAX_BYTES,
  BUNDLED_AGENT_STATE_RULES_VERSION,
  parseAgentStateRulesBundle,
  type AgentStateRulesBundle
} from './agent-state-rules-bundle'
import { AGENT_STATE_RULES_ENGINE_VERSION } from './agent-state-rules-schema'

const REFRESH_INTERVAL_MS = 4 * 60 * 60 * 1000
const FETCH_TIMEOUT_MS = 30_000

export type AgentStateRulesChannel = 'next' | 'stable'

export function agentStateRulesChannelForAppVersion(
  appVersion: string
): AgentStateRulesChannel | null {
  const channel = getVersionChannel(appVersion)
  if (!channel) {
    return null
  }
  return channel === 'stable' ? 'stable' : 'next'
}

// Fixed download URLs avoid API rate limits and latest-release redirects.
export function agentStateRulesDownloadUrl(channel: AgentStateRulesChannel): string {
  const tag = `agent-state-rules-engine-${AGENT_STATE_RULES_ENGINE_VERSION}-${channel}`
  return `https://github.com/${MAIN_RELEASE_REPO}/releases/download/${tag}/agent-state-rules.json`
}

// Shared userData must not expose next-only rules to stable builds.
export function agentStateRulesCacheFileName(channel: AgentStateRulesChannel): string {
  return `agent-state-rules-${channel}.json`
}

type LiveUpdateSettings = Pick<GlobalSettings, 'agentStateRulesPath' | 'agentStateRulesLiveUpdates'>

export type AgentStateRulesLiveUpdateDeps = {
  userDataPath: string
  appVersion: string
  /** Unpackaged dev and test runs never download. */
  isPackaged: boolean
  fetch: (url: string, init?: RequestInit) => Promise<Response>
  readSettings: () => LiveUpdateSettings
  onActivated: (rules: { version: number; source: AgentStateRulesSource }) => void
}

function warn(message: string): void {
  console.warn(`[agent-state-rules] ${message}`)
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function parseOrWarn(
  label: string,
  text: string,
  scope: 'live-updatable' | 'any-agent'
): AgentStateRulesBundle | null {
  const parsed = parseAgentStateRulesBundle(text, scope)
  if (!parsed.ok) {
    warn(`${label} rejected: ${parsed.error}`)
    return null
  }
  return parsed.bundle
}

async function readBundleFile(
  label: string,
  path: string,
  scope: 'live-updatable' | 'any-agent',
  warnIfMissing: boolean
): Promise<AgentStateRulesBundle | null> {
  try {
    return parseOrWarn(label, await readFile(path, 'utf8'), scope)
  } catch (error) {
    const missing = error instanceof Error && 'code' in error && error.code === 'ENOENT'
    if (!missing || warnIfMissing) {
      warn(`${label} unreadable: ${describeError(error)}`)
    }
    return null
  }
}

/** Prefer override, then newer download, then bundled rules; failures retain the last good copy. */
export class AgentStateRulesLiveUpdater {
  private override: AgentStateRulesBundle | null = null
  /** Newer than bundled; also the download version floor. */
  private downloaded: AgentStateRulesBundle | null = null
  // Restarted settings must fence still-pending reads/fetches from the previous run.
  private run: { channel: AgentStateRulesChannel | null } | null = null
  private timer: ReturnType<typeof setInterval> | null = null

  constructor(private readonly deps: AgentStateRulesLiveUpdateDeps) {}

  /** Reload on settings changes; fetch immediately and periodically after loading local rules. */
  async start(): Promise<void> {
    this.stop()
    const settings = this.deps.readSettings()
    const live = this.deps.isPackaged && settings.agentStateRulesLiveUpdates !== false
    const run = { channel: live ? agentStateRulesChannelForAppVersion(this.deps.appVersion) : null }
    this.run = run
    const overridePath = settings.agentStateRulesPath
    const [override, cached] = await Promise.all([
      // User-selected overrides bypass the release transcript gate.
      overridePath
        ? readBundleFile(`override ${overridePath}`, overridePath, 'any-agent', true)
        : null,
      run.channel
        ? readBundleFile('cached rules', this.cachePath(run.channel), 'live-updatable', false)
        : null
    ])
    if (this.run !== run) {
      return
    }
    this.override = override
    // An app update may have bundled rules newer than the cache.
    this.downloaded = cached && cached.version > BUNDLED_AGENT_STATE_RULES_VERSION ? cached : null
    this.activate()
    if (run.channel) {
      this.timer = setInterval(() => void this.refresh(), REFRESH_INTERVAL_MS)
      this.timer.unref?.()
      await this.refresh()
    }
  }

  stop(): void {
    this.run = null
    if (this.timer) {
      clearInterval(this.timer)
      this.timer = null
    }
  }

  /** Fetches the channel's file now; does nothing unless started with live updates on. */
  async refresh(): Promise<void> {
    const run = this.run
    if (!run?.channel) {
      return
    }
    const text = await this.fetchText(run.channel)
    if (this.run !== run || text === null) {
      return
    }
    const bundle = parseOrWarn('download', text, 'live-updatable')
    // Never downgrade either bundled or cached fixes.
    const floor = this.downloaded?.version ?? BUNDLED_AGENT_STATE_RULES_VERSION
    if (!bundle || bundle.version <= floor) {
      return
    }
    this.downloaded = bundle
    this.activate()
    try {
      await writePluginFileAtomically(this.cachePath(run.channel), text)
    } catch (error) {
      warn(`downloaded rules not cached: ${describeError(error)}`)
    }
  }

  private cachePath(channel: AgentStateRulesChannel): string {
    return join(this.deps.userDataPath, agentStateRulesCacheFileName(channel))
  }

  private async fetchText(channel: AgentStateRulesChannel): Promise<string | null> {
    try {
      const response = await this.deps.fetch(agentStateRulesDownloadUrl(channel), {
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS)
      })
      if (!response.ok) {
        await response.body?.cancel().catch(() => undefined)
        // Re-uploads can briefly return 404; retain the last good rules.
        warn(`download failed: HTTP ${response.status}`)
        return null
      }
      return await readFetchResponseTextWithinLimit(response, AGENT_STATE_RULES_BUNDLE_MAX_BYTES)
    } catch (error) {
      warn(`download failed: ${describeError(error)}`)
      return null
    }
  }

  private resolveActive(): ActiveAgentStateRules {
    const chosen = this.override ?? (this.downloaded?.bundledOnly ? null : this.downloaded)
    if (!chosen) {
      return BUNDLED_AGENT_STATE_RULES
    }
    return {
      files: overlayOnBundledAgentStateRules(chosen.files),
      version: chosen.version,
      source: chosen === this.override ? 'override' : 'downloaded'
    }
  }

  private activate(): void {
    const previous = getActiveAgentStateRules()
    const next = this.resolveActive()
    activateAgentStateRules(next)
    if (previous.version !== next.version || previous.source !== next.source) {
      this.deps.onActivated({ version: next.version, source: next.source })
    }
  }
}

type SettingsStore = {
  getSettings: () => LiveUpdateSettings
  onSettingsChanged: (listener: (updates: Partial<GlobalSettings>) => void) => unknown
}

/** Each host fetches its own rules; paired clients cannot supply host evaluation rules. */
export function startAgentStateRulesLiveUpdates(
  store: SettingsStore,
  onActivated: AgentStateRulesLiveUpdateDeps['onActivated']
): void {
  const environment = getAppEnvironment()
  const updater = new AgentStateRulesLiveUpdater({
    userDataPath: environment.getPath('userData'),
    appVersion: environment.getVersion(),
    isPackaged: environment.isPackaged(),
    fetch: (url, init) => getMainHttpClient().fetch(url, init),
    readSettings: () => store.getSettings(),
    onActivated
  })
  void updater.start()
  store.onSettingsChanged((updates) => {
    if ('agentStateRulesPath' in updates || 'agentStateRulesLiveUpdates' in updates) {
      void updater.start()
    }
  })
  environment.onWillQuit(() => updater.stop())
}
