import { readFile } from 'node:fs/promises'
import {
  createTomlLineScanState,
  getTomlTableHeader,
  isTomlStructuralLine,
  parseTomlSingleLineStringValue,
  parseTomlStringValue,
  updateTomlLineScanState
} from '../codex/configuration/toml/config-toml-line-scan'

export type CodexCredentialStoreMode = 'file' | 'keyring' | 'auto' | 'ephemeral'

/** Store modes whose logins can live outside `<home>/auth.json`. */
export function credentialStoreMayBypassAuthJson(mode: CodexCredentialStoreMode): boolean {
  // `ephemeral` logins die with their process, so no other process can observe them.
  return mode === 'keyring' || mode === 'auto'
}

/** Reads top-level `cli_auth_credentials_store` from a Codex home's config.toml; `file` is the Codex default. */
export async function readCodexCredentialStoreMode(
  configTomlPath: string
): Promise<CodexCredentialStoreMode> {
  try {
    return readTopLevelCredentialStoreValue(await readFile(configTomlPath, 'utf-8')) ?? 'file'
  } catch {
    return 'file'
  }
}

export function readTopLevelCredentialStoreValue(config: string): CodexCredentialStoreMode | null {
  let state = createTomlLineScanState()
  let lineOffset = 0
  for (const line of config.split('\n')) {
    if (isTomlStructuralLine(state)) {
      if (getTomlTableHeader(line)) {
        return null
      }
      const valueOffset = getCredentialsStoreValueOffset(line)
      if (valueOffset !== null) {
        const value = parseTomlStringValue(config, lineOffset + valueOffset)?.value ?? null
        const normalized = value?.trim().toLowerCase()
        if (
          normalized === 'file' ||
          normalized === 'keyring' ||
          normalized === 'auto' ||
          normalized === 'ephemeral'
        ) {
          return normalized
        }
        return null
      }
    }
    state = updateTomlLineScanState(state, line)
    lineOffset += line.length + 1
  }
  return null
}

function getCredentialsStoreValueOffset(line: string): number | null {
  let index = 0
  while (line[index] === ' ' || line[index] === '\t') {
    index += 1
  }

  if (line.startsWith('cli_auth_credentials_store', index)) {
    index += 'cli_auth_credentials_store'.length
  } else {
    const parsedKey = parseTomlSingleLineStringValue(line, index)
    if (parsedKey?.value !== 'cli_auth_credentials_store') {
      return null
    }
    index = parsedKey.end
  }

  while (line[index] === ' ' || line[index] === '\t') {
    index += 1
  }
  return line[index] === '=' ? index + 1 : null
}
