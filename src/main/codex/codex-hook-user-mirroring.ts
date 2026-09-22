import { existsSync, readFileSync } from 'node:fs'
import {
  readHooksJsonWithRaw,
  removeManagedCommands,
  type HookDefinition
} from '../agent-hooks/installer-utils'
import {
  computeTrustKey,
  escapeTomlString,
  getCodexExplicitHomeHookSourcePath,
  parseTrustKey,
  writeConfigAtomically,
  type CodexTrustEntry
} from './config-toml-trust'
import { createCodexHookTrustEntry, getCodexHookTrustSignature } from './codex-hook-identity'
import {
  CODEX_MANAGED_EVENT_LABELS,
  CODEX_PLUGIN_ONLY_HOOK_PLACEHOLDERS,
  getConfigPath,
  getSystemConfigPath
} from './codex-hook-definition'
import {
  getTrustedSystemUserHookSignatures,
  type TrustedSystemHookSignatureState
} from './codex-hook-system-trust'

type MirroredRuntimeUserHookTrustEntry = {
  entry: CodexTrustEntry
  enabled: boolean
}

function commandUsesCodexPluginOnlyPlaceholder(command: string | undefined): boolean {
  return (
    typeof command === 'string' &&
    CODEX_PLUGIN_ONLY_HOOK_PLACEHOLDERS.some((placeholder) => command.includes(placeholder))
  )
}

function removeCodexPluginEnvironmentCommands(definitions: HookDefinition[]): HookDefinition[] {
  // Why: plugin placeholders only resolve for Codex plugin hook sources; mirroring them into a plain runtime hooks.json turns them into 127s.
  return removeManagedCommands(definitions, commandUsesCodexPluginOnlyPlaceholder)
}

export function getRuntimeHooksWithSystemUserHooks(
  runtimeHooks: Record<string, HookDefinition[]> | undefined,
  isManagedCommand: (command: string | undefined) => boolean,
  runtimeConfigPath: string = getConfigPath()
): {
  hooks: Record<string, HookDefinition[]>
  trustEntries: MirroredRuntimeUserHookTrustEntry[]
} | null {
  const systemConfigPath = getSystemConfigPath()
  if (systemConfigPath === runtimeConfigPath) {
    return { hooks: { ...runtimeHooks }, trustEntries: [] }
  }

  const { raw: systemRaw, config: systemConfig } = readHooksJsonWithRaw(systemConfigPath)
  if (!systemConfig && systemRaw === null) {
    // Why: rebuilding from an unreadable source drops the last-known user hooks
    // from the managed runtime; let launch prep retry without changing it.
    return null
  }
  if (!systemConfig?.hooks) {
    return { hooks: {}, trustEntries: [] }
  }

  const nextHooks: Record<string, HookDefinition[]> = {}
  const trustedSystemHookSignatures = getTrustedSystemUserHookSignatures(
    systemConfigPath,
    systemConfig.hooks,
    isManagedCommand
  )
  for (const [eventName, systemDefinitions] of Object.entries(systemConfig.hooks)) {
    if (!Array.isArray(systemDefinitions)) {
      continue
    }

    const systemUserDefinitions = removeCodexPluginEnvironmentCommands(
      removeManagedCommands(systemDefinitions, isManagedCommand)
    )
    if (systemUserDefinitions.length === 0) {
      continue
    }

    // Why: rebuild from system hooks; reusing old runtime copies would keep deleted/edited ~/.codex/hooks.json entries alive for new sessions.
    nextHooks[eventName] = dedupeHookDefinitions(systemUserDefinitions)
  }

  return {
    hooks: nextHooks,
    trustEntries: collectMirroredRuntimeUserHookTrustEntries(
      runtimeConfigPath,
      nextHooks,
      trustedSystemHookSignatures,
      isManagedCommand
    )
  }
}

function collectMirroredRuntimeUserHookTrustEntries(
  runtimeConfigPath: string,
  runtimeHooks: Record<string, HookDefinition[]>,
  trustedSystemHookSignatures: ReadonlyMap<string, TrustedSystemHookSignatureState>,
  isManagedCommand: (command: string | undefined) => boolean
): MirroredRuntimeUserHookTrustEntry[] {
  if (trustedSystemHookSignatures.size === 0) {
    return []
  }

  const entries: MirroredRuntimeUserHookTrustEntry[] = []
  const trustSourcePath = getCodexExplicitHomeHookSourcePath(runtimeConfigPath)
  for (const [eventName, definitions] of Object.entries(runtimeHooks)) {
    if (!Array.isArray(definitions)) {
      continue
    }
    definitions.forEach((definition, groupIndex) => {
      const hooks = Array.isArray(definition.hooks) ? definition.hooks : []
      hooks.forEach((hook, handlerIndex) => {
        if (isManagedCommand(hook.command)) {
          return
        }
        const entry = createCodexHookTrustEntry(
          trustSourcePath,
          eventName,
          groupIndex,
          handlerIndex,
          definition,
          hook
        )
        if (!entry) {
          return
        }
        const signature = getCodexHookTrustSignature(entry)
        const state = trustedSystemHookSignatures.get(signature)
        if (state !== undefined) {
          entries.push({
            entry: { ...entry, trustedHash: state.trustedHash },
            enabled: state.enabled
          })
        }
      })
    })
  }
  return entries
}

export function moveMirroredRuntimeUserTrustAfterManagedStatusHook(
  entries: readonly MirroredRuntimeUserHookTrustEntry[]
): MirroredRuntimeUserHookTrustEntry[] {
  return entries.map(({ entry, enabled }) => {
    if (!CODEX_MANAGED_EVENT_LABELS.has(entry.eventLabel)) {
      return { entry, enabled }
    }
    return {
      entry: { ...entry, groupIndex: entry.groupIndex + 1 },
      enabled
    }
  })
}

function escapeRegex(value: string): string {
  return value.replaceAll(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function buildHookTrustHeaderKeyPattern(key: string): string {
  const keyVariants = [key]
  const parsed = parseTrustKey(key)
  if (parsed && /^[A-Za-z]:[\\/]|^\\\\/.test(parsed.sourcePath)) {
    const suffix = `:${parsed.eventLabel}:${parsed.groupIndex}:${parsed.handlerIndex}`
    keyVariants.push(
      `${parsed.sourcePath.replace(/\\/g, '/')}${suffix}`,
      `${parsed.sourcePath.replace(/\//g, '\\')}${suffix}`
    )
  }
  const alternatives = [...new Set(keyVariants)].flatMap((variant) => {
    const quoted = [`"${escapeRegex(escapeTomlString(variant))}"`]
    if (!variant.includes("'")) {
      // Why: tolerate raw-backslash literal keys from Codex/manual approval while repairing mirrored runtime trust across both Windows variants.
      quoted.push(`'${escapeRegex(variant)}'`)
    }
    return quoted
  })
  return `(?:${alternatives.join('|')})`
}

export function applyMirroredRuntimeUserHookTrustStates(
  tomlPath: string,
  entries: readonly MirroredRuntimeUserHookTrustEntry[]
): void {
  if (entries.length === 0 || !existsSync(tomlPath)) {
    return
  }

  const existing = readFileSync(tomlPath, 'utf-8')
  let updated = existing
  for (const { entry, enabled } of entries) {
    const headerKeyPattern = buildHookTrustHeaderKeyPattern(computeTrustKey(entry))
    const pattern = new RegExp(
      `(\\[hooks\\.state\\.${headerKeyPattern}\\]\\r?\\n[ \\t]*enabled[ \\t]*=[ \\t]*)(true|false)`,
      'g'
    )
    updated = updated.replace(pattern, `$1${enabled}`)
  }
  if (updated !== existing) {
    writeConfigAtomically(tomlPath, updated)
  }
}

function dedupeHookDefinitions(definitions: readonly HookDefinition[]): HookDefinition[] {
  const seen = new Set<string>()
  return definitions.filter((definition) => {
    const key = JSON.stringify(definition)
    if (seen.has(key)) {
      return false
    }
    seen.add(key)
    return true
  })
}
