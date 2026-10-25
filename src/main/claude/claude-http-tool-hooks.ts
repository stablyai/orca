import {
  createManagedCommandMatcher,
  hookDefinitionHasManagedCommand,
  isPlainObject,
  MANAGED_HOOK_TIMEOUT_SECONDS,
  readHooksJson,
  writeHooksJson,
  type HookCommandConfig,
  type HooksConfig
} from '../agent-hooks/installer-utils'
import { buildManagedHttpHook, type ManagedHttpHookTarget } from '../agent-hooks/managed-http-hook'
import {
  claudeAcceptsExecFormHooks,
  claudeVersionReaches,
  parseClaudeCliVersion
} from './claude-hook-event-versions'
import { CLAUDE_HTTP_TOOL_HOOK_EVENTS } from './claude-managed-hook-events'
import {
  CLAUDE_HOOK_SETTINGS,
  getConfigPath,
  getManagedEventHook,
  getManagedScriptFileName,
  getManagedScriptPath,
  hasSameManagedHookInvocation,
  type ClaudeCompatibleHookSettings,
  type NativeHookFormOptions
} from './hook-settings'

/** Opt-in while the http transport is new: `ORCA_CLAUDE_HTTP_HOOKS=1` in Orca's environment. */
export const CLAUDE_HTTP_TOOL_HOOKS_ENV = 'ORCA_CLAUDE_HTTP_HOOKS'

const SUBPROCESS_ENV_SCRUB = 'CLAUDE_CODE_SUBPROCESS_ENV_SCRUB'

// Claude Code 2.1.63 added `type: "http"` hooks; an older CLI must keep reading the script.
export const CLAUDE_HTTP_HOOKS_FIRST_VERSION = '2.1.63'

// Windows keeps its native launcher; the http path is measured on macOS and Linux only.
export function isClaudeHttpToolHooksRequested(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform
): boolean {
  return platform !== 'win32' && env[CLAUDE_HTTP_TOOL_HOOKS_ENV] === '1'
}

function isScrubValue(value: unknown): boolean {
  return typeof value === 'string' && !['', '0', 'false'].includes(value.trim().toLowerCase())
}

// Claude Code then refuses to interpolate *TOKEN and *KEY names into http headers.
export function isClaudeSubprocessEnvScrubbed(
  config: HooksConfig,
  env: NodeJS.ProcessEnv = process.env
): boolean {
  const settingsEnv = isPlainObject(config.env) ? config.env : {}
  return isScrubValue(settingsEnv[SUBPROCESS_ENV_SCRUB]) || isScrubValue(env[SUBPROCESS_ENV_SCRUB])
}

// Set by the desktop while its listener serves http tool hooks; workers and other agents never see it.
let liveClaudeHttpToolHookPort: number | null = null
// Startup sync has no CLI probe of its own; it reuses the version the last install probed.
let lastProbedClaudeVersion: string | null = null

export function setClaudeHttpToolHookPort(port: number | null): void {
  liveClaudeHttpToolHookPort = port !== null && Number.isInteger(port) && port > 0 ? port : null
}

/** Only the default Claude home on POSIX gets http entries; profiles and scrubbed setups keep the script. */
export function resolveClaudeHttpToolHookTarget(
  agent: string,
  config: HooksConfig,
  configDir: string | undefined,
  claudeVersion?: string
): ManagedHttpHookTarget | null {
  if (agent !== 'claude' || configDir !== undefined) {
    return null
  }
  if (parseClaudeCliVersion(claudeVersion) !== null) {
    lastProbedClaudeVersion = claudeVersion ?? null
  }
  if (
    !claudeVersionReaches(claudeVersion ?? lastProbedClaudeVersion, CLAUDE_HTTP_HOOKS_FIRST_VERSION)
  ) {
    return null
  }
  return resolveListenerTarget(config)
}

/** The live listener for the default Claude home, without the CLI version gate. */
function resolveListenerTarget(config: HooksConfig): ManagedHttpHookTarget | null {
  if (
    process.platform === 'win32' ||
    liveClaudeHttpToolHookPort === null ||
    isClaudeSubprocessEnvScrubbed(config)
  ) {
    return null
  }
  return { port: liveClaudeHttpToolHookPort, source: 'claude' }
}

/** The managed entry for one event: http for tool events while the listener serves, else the script. */
export function getManagedClaudeEventHook(
  eventName: string,
  scriptPath: string,
  settings: ClaudeCompatibleHookSettings,
  nativeHookPath: string | null,
  http: ManagedHttpHookTarget | null,
  formOptions: NativeHookFormOptions = {}
): HookCommandConfig {
  if (!http || !CLAUDE_HTTP_TOOL_HOOK_EVENTS.includes(eventName)) {
    return getManagedEventHook(eventName, scriptPath, settings, nativeHookPath, formOptions)
  }
  const hook = buildManagedHttpHook(http, settings.scriptBaseName, MANAGED_HOOK_TIMEOUT_SECONDS)
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: an http entry has no command; readers of a hooks file already meet entries without one and match this one on url.
  return hook as HookCommandConfig
}

/** Install writes `hookFor`; status accepts any of `formsFor`, so either tool-event transport counts. */
export function managedClaudeEventHooks(
  service: { agent: string; settings: ClaudeCompatibleHookSettings },
  config: HooksConfig,
  options: { configDir?: string; claudeVersion?: string },
  scriptPath: string,
  nativeHookPath: string | null
): {
  hookFor: (eventName: string) => HookCommandConfig
  formsFor: (eventName: string) => HookCommandConfig[]
} {
  const { agent, settings } = service
  const http = resolveClaudeHttpToolHookTarget(
    agent,
    config,
    options.configDir,
    options.claudeVersion
  )
  const eventHook = (
    eventName: string,
    path: string | null,
    target: ManagedHttpHookTarget | null,
    formOptions: NativeHookFormOptions = {}
  ) => getManagedClaudeEventHook(eventName, scriptPath, settings, path, target, formOptions)
  const execForm = claudeAcceptsExecFormHooks(options.claudeVersion)
  return {
    hookFor: (eventName) => eventHook(eventName, nativeHookPath, http, { execForm }),
    formsFor: (eventName) => [
      // An installed exec form proves its CLI accepted it, whatever the probe now reports.
      eventHook(eventName, null, null, { execForm: true }),
      eventHook(eventName, nativeHookPath, null, { execForm: true }),
      ...(http ? [eventHook(eventName, null, http)] : [])
    ]
  }
}

/**
 * Swap Orca's tool-event entries in place; an event without an Orca entry stays untouched.
 * With `keepScriptEntries`, Orca's script entries stay as they are and only its http
 * entries move, so a sync that cannot check the CLI version never adds an http entry.
 */
export function retargetManagedToolHooks(
  config: HooksConfig,
  hookForEvent: (eventName: string) => HookCommandConfig,
  scriptFileName: string,
  options: { keepScriptEntries?: boolean } = {}
): { config: HooksConfig; changed: boolean } {
  const isManagedCommand = createManagedCommandMatcher(scriptFileName)
  const isManagedHook = (hook: HookCommandConfig): boolean =>
    hookDefinitionHasManagedCommand({ hooks: [hook] }, isManagedCommand)
  const nextHooks = { ...config.hooks }
  let changed = false
  for (const eventName of CLAUDE_HTTP_TOOL_HOOK_EVENTS) {
    const definitions = nextHooks[eventName]
    if (!Array.isArray(definitions)) {
      continue
    }
    const expected = hookForEvent(eventName)
    nextHooks[eventName] = definitions.map((definition) => {
      if (!Array.isArray(definition.hooks)) {
        return definition
      }
      const hooks = definition.hooks.map((hook) => {
        const current =
          hasSameManagedHookInvocation(hook, expected) && hook.timeout === expected.timeout
        if (!isManagedHook(hook) || current) {
          return hook
        }
        if (options.keepScriptEntries && hook.type !== 'http') {
          return hook
        }
        changed = true
        return expected
      })
      return { ...definition, hooks }
    })
  }
  return changed ? { config: { ...config, hooks: nextHooks }, changed } : { config, changed }
}

/** Point Orca's Claude tool-event entries at the live listener, or back at the script. */
export function syncClaudeHttpToolHooks(): boolean {
  if (process.platform === 'win32') {
    return false
  }
  const configPath = getConfigPath(CLAUDE_HOOK_SETTINGS)
  const config = readHooksJson(configPath)
  if (!config) {
    return false
  }
  const scriptPath = getManagedScriptPath(CLAUDE_HOOK_SETTINGS)
  // Startup sync can run before any install has probed the CLI, and an unknown version
  // fails the gate. Instead of sending a previous run's http entries back to the script,
  // keep each entry on the transport it already uses and move http entries to the live port.
  const versionUnknown = liveClaudeHttpToolHookPort !== null && lastProbedClaudeVersion === null
  const target = versionUnknown
    ? resolveListenerTarget(config)
    : resolveClaudeHttpToolHookTarget('claude', config, undefined)
  const { config: next, changed } = retargetManagedToolHooks(
    config,
    (eventName) =>
      getManagedClaudeEventHook(eventName, scriptPath, CLAUDE_HOOK_SETTINGS, null, target),
    getManagedScriptFileName(CLAUDE_HOOK_SETTINGS),
    { keepScriptEntries: versionUnknown }
  )
  if (changed) {
    writeHooksJson(configPath, next)
  }
  return changed
}

function syncClaudeHttpToolHooksSafely(): void {
  try {
    syncClaudeHttpToolHooks()
  } catch (error) {
    console.warn('[agent-hooks] could not update Claude tool hook entries:', error)
  }
}

/** Desktop startup, once the listener is bound: move Orca's tool-event entries onto it. */
export function startClaudeHttpToolHooks(port: number): void {
  setClaudeHttpToolHookPort(port)
  syncClaudeHttpToolHooksSafely()
}

/** Quit: hand the tool events back to the script, which works with Orca down or restarted. */
export function stopClaudeHttpToolHooks(): void {
  if (liveClaudeHttpToolHookPort === null) {
    return
  }
  setClaudeHttpToolHookPort(null)
  syncClaudeHttpToolHooksSafely()
}
