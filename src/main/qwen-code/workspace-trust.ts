import { realpathSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { applyEdits, modify, parse, type ParseError } from 'jsonc-parser'
import { isDefinitiveAbsence } from '../../shared/errors/definitive-filesystem-absence'
import { isPlainObject } from '../agent-hooks/installation/configuration/hooks-json-read'
import { writeHooksJson } from '../agent-hooks/installation/configuration/hooks-json-write'
import { readObservedFileSync } from '../filesystem/file-content-observation'
import { withTrustDirectory } from '../qoder/workspace-trust'

/** text is null when the file does not exist. */
type JsoncObjectFile = { text: string | null; config: Record<string, unknown> }

// Qwen strips comments before parsing; absence reads as an empty object, unreadable or invalid as null.
function readJsoncObject(path: string): JsoncObjectFile | null {
  let text: string
  try {
    text = readObservedFileSync(path, 'utf8').replace(/^\uFEFF/, '')
  } catch (error) {
    return isDefinitiveAbsence(error) ? { text: null, config: {} } : null
  }
  const errors: ParseError[] = []
  const config: unknown = parse(text, errors)
  return errors.length === 0 && isPlainObject(config) ? { text, config } : null
}

/**
 * Trust a workspace for Qwen Code 1.0 (permissions.trustDirectories).
 * Synchronous like the Qoder writer, so concurrent launches and Orca's Qwen hook install cannot interleave a read-modify-write.
 */
export function markQwenWorkspaceTrusted(
  workspacePath: string,
  env: Record<string, string | undefined>,
  home: string
): void {
  let canonicalPath = workspacePath
  try {
    canonicalPath = realpathSync.native(workspacePath)
  } catch {
    // Missing paths retain their supplied spelling.
  }
  // Mirrors Qwen 1.0 getConfigHomeDir.
  const configDir = env.QWEN_CONFIG_DIR
    ? resolve(env.QWEN_CONFIG_DIR)
    : join(env.QWEN_CLI_HOME || home, '.qwen')
  const settingsPath = join(configDir, 'settings.json')
  const settings = readJsoncObject(settingsPath)
  const updated = settings && withTrustDirectory(settings.config, canonicalPath)
  if (!settings || !updated || updated === settings.config) {
    return
  }
  // Edit the original text so user comments and formatting survive.
  const text = settings.text ?? ''
  const edits = modify(text, ['permissions', 'trustDirectories', -1], canonicalPath, {
    formattingOptions: { insertSpaces: true, tabSize: 2 },
    isArrayInsertion: true
  })
  writeHooksJson(settingsPath, settings.config, {
    serialized: applyEdits(text, edits),
    defaultMode: 0o600
  })
}
