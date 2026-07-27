import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { readHooksJson, type HookDefinition } from '../agent-hooks/installer-utils'
import { extractInlineCodexHooks, stripInlineCodexHookSections } from './config-toml-hooks'

export type SystemCodexHookAuthority = {
  sourcePath: string
  hooks: Record<string, HookDefinition[]>
}

export function readSystemCodexHookAuthority(
  systemHomePath: string,
  onInlineError?: (error: unknown) => void
): SystemCodexHookAuthority | null {
  const systemTomlPath = join(systemHomePath, 'config.toml')
  try {
    const config = readFileSync(systemTomlPath, 'utf-8')
    const hooks = extractInlineCodexHooks(config)
    if (Object.keys(hooks).length > 0) {
      try {
        // Why: extraction and runtime-mirror removal must cover the same
        // syntax. If a valid spelling cannot be stripped, fail closed instead
        // of materializing the same command in two runtime authorities.
        stripInlineCodexHookSections(config)
      } catch (error) {
        onInlineError?.(error)
        return { sourcePath: systemTomlPath, hooks: {} }
      }
      return {
        sourcePath: systemTomlPath,
        hooks
      }
    }
  } catch (error) {
    if ((error as { code?: unknown })?.code !== 'ENOENT') {
      onInlineError?.(error)
    }
  }

  // Why: pre-migration Codex stores settings/trust in config.toml while hook
  // declarations still live in hooks.json, so an empty or unreadable inline
  // layer must retain that compatibility path until the authority migrates.
  const legacyHooksPath = join(systemHomePath, 'hooks.json')
  const legacyConfig = readHooksJson(legacyHooksPath)
  return legacyConfig?.hooks ? { sourcePath: legacyHooksPath, hooks: legacyConfig.hooks } : null
}
