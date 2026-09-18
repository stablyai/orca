import { randomUUID } from 'node:crypto'
import { lstat, readFile, realpath, rename, rm, stat, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { isDefinitiveAbsence } from '../../shared/definitive-filesystem-absence'
import { parseHooksJsonText } from '../agent-hooks/hooks-json-read'
import {
  createManagedCommandMatcher,
  isPlainObject,
  type HookCommandConfig,
  type HookDefinition,
  type HooksConfig
} from '../agent-hooks/installer-utils'
import {
  getConfigPath,
  getManagedCommand,
  getManagedLifecycleHook,
  getManagedScriptFileName,
  getManagedScriptPath,
  getStatusLineScriptFileName,
  getStatusLineScriptPath,
  getStatusLineSlotState,
  hasSameManagedHookInvocation,
  type ClaudeCompatibleHookSettings
} from './hook-settings'

const DIRECT_COMMAND_KEYS = ['command', 'bash', 'powershell'] as const

function isManagedHookEntry(
  hook: HookCommandConfig,
  isManagedCommand: (command: string | undefined) => boolean
): boolean {
  if (!isPlainObject(hook)) {
    return false
  }
  const args = Array.isArray(hook.args) ? hook.args : []
  return (
    isManagedCommand(hook.command) ||
    args.some((arg) => typeof arg === 'string' && isManagedCommand(arg))
  )
}

function needsManagedInvocationUpdate(
  actual: HookCommandConfig,
  expected: HookCommandConfig
): boolean {
  return (
    actual.type !== expected.type ||
    actual.timeout !== expected.timeout ||
    !hasSameManagedHookInvocation(actual, expected)
  )
}

function withCurrentManagedInvocation(
  actual: HookCommandConfig,
  expected: HookCommandConfig
): HookCommandConfig {
  const next: HookCommandConfig = {
    ...actual,
    type: expected.type,
    command: expected.command,
    timeout: expected.timeout
  }
  if (expected.args === undefined) {
    delete next.args
  } else {
    next.args = expected.args
  }
  return next
}

function reconcileDefinition(
  definition: HookDefinition,
  hook: HookCommandConfig,
  isManagedCommand: (command: string | undefined) => boolean
): HookDefinition {
  if (!isPlainObject(definition)) {
    return definition
  }
  let changed = false
  const next: HookDefinition = { ...definition }
  for (const key of DIRECT_COMMAND_KEYS) {
    const value = definition[key]
    if (typeof value === 'string' && isManagedCommand(value) && value !== hook.command) {
      next[key] = hook.command
      changed = true
    }
  }
  if (Array.isArray(definition.hooks)) {
    const nextHooks = definition.hooks.map((entry) => {
      if (
        !isManagedHookEntry(entry, isManagedCommand) ||
        !needsManagedInvocationUpdate(entry, hook)
      ) {
        return entry
      }
      changed = true
      return withCurrentManagedInvocation(entry, hook)
    })
    if (changed) {
      next.hooks = nextHooks
    }
  }
  return changed ? next : definition
}

function reconcileExistingManagedHookSettings(
  config: HooksConfig,
  hook: HookCommandConfig,
  scriptFileName: string,
  statusLine: { command: string; scriptFileName: string }
): { config: HooksConfig; changed: boolean } {
  const isManagedCommand = createManagedCommandMatcher(scriptFileName)
  const currentHooks = config.hooks
  const nextHooks = { ...currentHooks }
  let changed = false

  for (const [eventName, definitions] of Object.entries(nextHooks)) {
    if (!Array.isArray(definitions)) {
      continue
    }
    let eventChanged = false
    const nextDefinitions = definitions.map((definition) => {
      const nextDefinition = reconcileDefinition(definition, hook, isManagedCommand)
      if (nextDefinition !== definition) {
        eventChanged = true
      }
      return nextDefinition
    })
    if (eventChanged) {
      changed = true
      nextHooks[eventName] = nextDefinitions
    }
  }

  let nextConfig: HooksConfig = changed ? { ...config, hooks: nextHooks } : config
  if (getStatusLineSlotState(nextConfig, statusLine.scriptFileName) !== 'managed') {
    return { config: nextConfig, changed }
  }
  const currentStatusLine = nextConfig.statusLine
  if (!isPlainObject(currentStatusLine) || currentStatusLine.command === statusLine.command) {
    return { config: nextConfig, changed }
  }
  return {
    config: { ...nextConfig, statusLine: { ...currentStatusLine, command: statusLine.command } },
    changed: true
  }
}

async function resolveExistingWritePath(configPath: string): Promise<string> {
  try {
    if (!(await lstat(configPath)).isSymbolicLink()) {
      return configPath
    }
  } catch (error) {
    if (isDefinitiveAbsence(error)) {
      return configPath
    }
    throw error
  }
  return realpath(configPath)
}

async function writeExistingHooksJson(configPath: string, config: HooksConfig): Promise<void> {
  const writePath = await resolveExistingWritePath(configPath)
  const serialized = `${JSON.stringify(config, null, 2)}\n`
  const existing = await stat(writePath)
  const tmpPath = join(dirname(writePath), `.${Date.now()}-${randomUUID()}.tmp`)
  try {
    await writeFile(tmpPath, serialized, { encoding: 'utf-8', mode: existing.mode })
    await rename(tmpPath, writePath)
  } finally {
    await rm(tmpPath, { force: true }).catch(() => undefined)
  }
}

// Why: Grok still imports ~/.claude settings after Claude CLI leaves PATH, so refresh
// must rewrite stale $SYSTEMROOT/$HOME commands without install()'s event fan-out (#17202).
export async function refreshExistingManagedHookSettings(
  settings: ClaudeCompatibleHookSettings
): Promise<void> {
  const configPath = getConfigPath(settings)
  let raw: string
  try {
    raw = await readFile(configPath, 'utf-8')
  } catch (error) {
    if (isDefinitiveAbsence(error)) {
      return
    }
    throw error
  }
  const config = parseHooksJsonText(raw)
  if (!config) {
    return
  }

  const { config: next, changed } = reconcileExistingManagedHookSettings(
    config,
    getManagedLifecycleHook(getManagedScriptPath(settings), settings),
    getManagedScriptFileName(settings),
    {
      command: getManagedCommand(getStatusLineScriptPath(settings)),
      scriptFileName: getStatusLineScriptFileName(settings)
    }
  )
  if (!changed) {
    return
  }
  await writeExistingHooksJson(configPath, next)
}
