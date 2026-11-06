import { isPlainObject } from '../agent-hooks/hooks-json-read'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { parse } from 'smol-toml'
import { MANAGED_HOOK_TIMEOUT_SECONDS } from '../agent-hooks/installer-utils'
import {
  CODEX_MANAGED_EVENT_LABELS,
  CODEX_EVENTS,
  buildCodexManagedHook,
  getManagedScriptPath
} from '../codex/hooks/definitions/codex-hook-definition'
import { getManagedCodexHookHome } from '../codex/trust/hooks/codex-hook-orca-approvals'
import { getCodexManagedHookTrustEntryKeys } from '../codex/trust/grants/codex-managed-trust-reconciliation'
import { readHookTrustContent } from '../codex/trust/toml/config-toml-hook-trust-read'
import { classifyHookTrustKey } from '../codex/configuration/toml/config-toml-runtime-owned-sections'
import { normalizeCodexHookTrustLookupKey as normalizeHookTrustKeyForLookup } from '../codex/trust/identity/codex-trust-identity'
import { buildCodexHookCommand as getManagedCommand } from '../codex/hooks/definitions/codex-hook-command-form'

function canonical(value: unknown): unknown {
  if (value instanceof Date) {
    return value.toISOString()
  }
  if (Array.isArray(value)) {
    return value.map(canonical)
  }
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, item]) => [key, canonical(item)])
    )
  }
  return value
}

export function readCodexTextConfiguration(home: string) {
  try {
    const file = join(home, 'config.toml')
    const raw = existsSync(file) ? readFileSync(file, 'utf8') : ''
    const config = parse(raw)
    if (
      (config.model_provider && config.model_provider !== 'openai') ||
      config.model_providers ||
      config.profile ||
      config.project_root_markers !== undefined ||
      (config.mcp_servers !== undefined &&
        (!isPlainObject(config.mcp_servers) || Object.keys(config.mcp_servers).length > 0)) ||
      config.chatgpt_base_url ||
      config.experimental_bearer_token ||
      config.experimental_bearer_token_env_var
    ) {
      return null
    }
    const managed = getManagedCodexHookHome(home)
    const owned = new Set(
      getCodexManagedHookTrustEntryKeys(readHookTrustContent(raw), {
        runtimeHomePath: home,
        sourcePaths: managed.keySourcePaths,
        command: getManagedCommand(getManagedScriptPath()),
        managedEventLabels: CODEX_MANAGED_EVENT_LABELS,
        timeoutSec: MANAGED_HOOK_TIMEOUT_SECONDS
      }).map(normalizeHookTrustKeyForLookup)
    )
    const hooks = config.hooks
    if (isPlainObject(hooks)) {
      const state = hooks.state
      if (isPlainObject(state)) {
        for (const [key, value] of Object.entries(state)) {
          if (classifyHookTrustKey(key, home) !== 'home-scoped') {
            continue
          }
          if (
            !owned.has(normalizeHookTrustKeyForLookup(key)) ||
            !isPlainObject(value) ||
            value.enabled === false ||
            Object.keys(value).some((field) => !['trusted_hash', 'enabled'].includes(field))
          ) {
            return null
          }
          delete state[key]
        }
        if (!Object.keys(state).length) {
          delete hooks.state
        }
      }
      if (!Object.keys(hooks).length) {
        delete config.hooks
      }
    }
    const hooksFile = join(home, 'hooks.json')
    const hooksRaw = existsSync(hooksFile) ? readFileSync(hooksFile, 'utf8') : ''
    const definitions: unknown = hooksRaw ? JSON.parse(hooksRaw) : null
    if (definitions !== null) {
      if (
        !isPlainObject(definitions) ||
        Object.keys(definitions).some((key) => key !== 'hooks') ||
        !isPlainObject(definitions.hooks)
      ) {
        return null
      }
      const command = getManagedCommand(getManagedScriptPath())
      for (const [name, groups] of Object.entries(definitions.hooks)) {
        const event = CODEX_EVENTS.find((event) => event === name)
        if (
          !event ||
          JSON.stringify(canonical(groups)) !==
            JSON.stringify(canonical([{ hooks: [buildCodexManagedHook(command, event)] }]))
        ) {
          return null
        }
      }
    }
    return { raw, hooksRaw, comparable: JSON.stringify(canonical({ config, definitions })) }
  } catch {
    return null
  }
}
