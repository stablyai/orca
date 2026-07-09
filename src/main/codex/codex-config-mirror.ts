import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { writeFileAtomically } from '../codex-accounts/fs-utils'
import { getOrcaManagedCodexHomePath, getSystemCodexHomePath } from './codex-home-paths'
import { normalizeDeprecatedCodexHookFeatureFlag } from './codex-config-hooks-feature-normalize'
import { rewriteRelativePathConfigValues } from './codex-config-path-reference-rewrite'
import { parseWslUncPath } from '../../shared/wsl-paths'
import { syncSystemProfileV2ConfigOverlaysIntoManagedHome } from './codex-profile-v2-config-overlay-mirror'
import {
  promoteCodexRuntimeSettingsToSystem,
  snapshotCodexRuntimeSettingsBaseline,
  type CodexSettingsPromotionHomes
} from './config-settings-promotion'
import {
  createTomlLineScanState,
  getTomlTableHeader,
  isTomlStructuralLine,
  updateTomlLineScanState
} from './config-toml-line-scan'

// Why: multi-account vault assumes auth.json; keyring/auto stores credentials
// outside managed homes and breaks account switching / presence detection.
const CLI_AUTH_CREDENTIALS_STORE_FILE_LINE = 'cli_auth_credentials_store = "file"'
const CLI_AUTH_CREDENTIALS_STORE_KEY_RE = /^[ \t]*cli_auth_credentials_store[ \t]*=/
const CLI_AUTH_CREDENTIALS_STORE_FILE_RE =
  /^[ \t]*cli_auth_credentials_store[ \t]*=[ \t]*(?:"file"|'file')[ \t\r]*(?:#.*)?$/

export function syncSystemConfigIntoManagedCodexHome(
  homes: CodexSettingsPromotionHomes = {
    runtimeHomePath: getOrcaManagedCodexHomePath(),
    systemHomePath: getSystemCodexHomePath()
  }
): void {
  // Why: the mirror overwrites runtime settings from ~/.codex, so changes the
  // user made inside Orca-launched Codex (/model, /approvals) must be written
  // back to ~/.codex first or this very pass silently reverts them.
  if (!promoteCodexRuntimeSettingsToSystem(homes)) {
    // Why: mirroring after a failed write-back would erase the runtime change;
    // leave both runtime and its old baseline intact so the next launch retries.
    return
  }
  try {
    syncSystemConfigIntoManagedCodexHomeUnsafe(homes)
  } catch (error) {
    console.warn('[codex-config] Failed to mirror system Codex config:', error)
    return
  }
  // Why: the baseline advances only after a successful mirror; recording an
  // unpromoted runtime change as Orca-written would strand it forever.
  snapshotCodexRuntimeSettingsBaseline(homes.runtimeHomePath)
}

function syncSystemConfigIntoManagedCodexHomeUnsafe({
  runtimeHomePath,
  systemHomePath
}: CodexSettingsPromotionHomes): void {
  const systemConfigPath = join(systemHomePath, 'config.toml')
  const runtimeConfigPath = join(runtimeHomePath, 'config.toml')
  const systemConfigExists = existsSync(systemConfigPath)
  const runtimeConfigExists = existsSync(runtimeConfigPath)
  // Why: profile-v2 overlays (`*.config.toml`) are sibling files Codex loads by
  // name; link them even when config.toml is missing so --profile-v2 still works.
  syncSystemProfileV2ConfigOverlaysIntoManagedHome()
  if (!systemConfigExists && !runtimeConfigExists) {
    return
  }

  const rawSystemConfig = systemConfigExists ? readFileSync(systemConfigPath, 'utf-8') : ''
  const sourceConfigDir = resolveCodexConfigMirrorSourceDirectory(systemHomePath)
  if (!runtimeConfigExists) {
    writeFileAtomically(
      runtimeConfigPath,
      prepareSystemConfigForFreshRuntimeMirror(rawSystemConfig, sourceConfigDir)
    )
    return
  }

  const systemConfig = prepareSystemConfigForRuntimeMirror(rawSystemConfig, sourceConfigDir)
  const runtimeConfig = readFileSync(runtimeConfigPath, 'utf-8')
  const mergedConfig = forceFileAuthCredentialsStore(
    mergeSystemCodexConfigIntoRuntime(runtimeConfig, systemConfig)
  )
  if (mergedConfig !== runtimeConfig) {
    writeFileAtomically(runtimeConfigPath, mergedConfig)
  }
}

export function resolveCodexConfigMirrorSourceDirectory(systemHomePath: string): string {
  return parseWslUncPath(systemHomePath)?.linuxPath ?? dirname(join(systemHomePath, 'config.toml'))
}

function prepareSystemConfigForRuntimeMirror(config: string, systemConfigDir: string): string {
  return rewriteRelativePathConfigValues(
    normalizeDeprecatedCodexHookFeatureFlag(config),
    systemConfigDir
  )
}

// Why: trust blocks reference a hooks.json path, so system-home hook trust
// entries are not valid in a fresh runtime CODEX_HOME until install remaps
// them. Also seeds WSL runtime homes, where systemConfigDir must be the
// Linux-side ~/.codex the config resolves against inside the distro.
export function prepareSystemConfigForFreshRuntimeMirror(
  config: string,
  systemConfigDir: string
): string {
  return forceFileAuthCredentialsStore(
    stripRuntimeOwnedTomlSections(prepareSystemConfigForRuntimeMirror(config, systemConfigDir))
  )
}

// Why: Orca multi-account vaults read/write CODEX_HOME/auth.json; force file
// store so mirrored keyring/auto mode cannot hide credentials from the vault.
export function forceFileAuthCredentialsStore(config: string): string {
  const lines = config.split('\n')
  let scanState = createTomlLineScanState()
  let existingKeyIndex: number | null = null

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? ''
    if (isTomlStructuralLine(scanState)) {
      if (getTomlTableHeader(line)) {
        break
      }
      if (CLI_AUTH_CREDENTIALS_STORE_KEY_RE.test(line)) {
        existingKeyIndex = index
        break
      }
    }
    scanState = updateTomlLineScanState(scanState, line)
  }

  if (existingKeyIndex !== null) {
    const existingLine = lines[existingKeyIndex] ?? ''
    if (CLI_AUTH_CREDENTIALS_STORE_FILE_RE.test(existingLine)) {
      return config
    }
    const indent = /^[ \t]*/.exec(existingLine)?.[0] ?? ''
    const lineEnding = existingLine.endsWith('\r') ? '\r' : ''
    lines[existingKeyIndex] = `${indent}${CLI_AUTH_CREDENTIALS_STORE_FILE_LINE}${lineEnding}`
    return lines.join('\n')
  }

  if (config.length === 0) {
    return `${CLI_AUTH_CREDENTIALS_STORE_FILE_LINE}\n`
  }
  return `${CLI_AUTH_CREDENTIALS_STORE_FILE_LINE}\n${config}`
}

function mergeSystemCodexConfigIntoRuntime(runtimeConfig: string, systemConfig: string): string {
  const runtimeSections = getTomlSections(runtimeConfig)
  const runtimeProjectHeaders = new Set(
    runtimeSections
      .filter((section) => isRuntimeProjectTomlSection(section.header))
      .map((section) => getTomlSectionHeaderKey(section.header))
  )
  const systemUntrustedProjectHeaders = new Set(
    getTomlSections(systemConfig)
      .filter((section) => isRuntimeProjectTomlSection(section.header))
      .filter((section) => getProjectTrustLevel(section.block) === 'untrusted')
      .map((section) => getTomlSectionHeaderKey(section.header))
  )
  // Why: ordinary Codex settings should mirror ~/.codex exactly; runtime hook
  // trust and project trust are written under Orca's managed CODEX_HOME and
  // must survive the copy unless the user explicitly revoked project trust in
  // the system config.
  return joinTomlBlocks([
    stripRuntimeOwnedTomlSections(systemConfig, runtimeProjectHeaders),
    ...runtimeSections
      .filter((section) => isRuntimePreservedTomlSection(section.header))
      .filter(
        (section) =>
          !isRuntimeProjectTomlSection(section.header) ||
          !systemUntrustedProjectHeaders.has(getTomlSectionHeaderKey(section.header))
      )
      .map((section) => section.block)
  ])
}

type TomlSection = {
  header: string
  block: string
  start: number
}

function stripRuntimeOwnedTomlSections(
  config: string,
  runtimeProjectHeaders = new Set<string>()
): string {
  const lines = config.split('\n')
  const sections = getTomlSections(config)
  const firstSectionIndex = sections[0]?.start ?? -1
  const preamble = firstSectionIndex === -1 ? config : lines.slice(0, firstSectionIndex).join('\n')
  return joinTomlBlocks([
    preamble,
    ...sections
      .filter((section) => !isRuntimeHookTrustTomlSection(section.header))
      .filter(
        (section) =>
          !isRuntimeProjectTomlSection(section.header) ||
          !runtimeProjectHeaders.has(getTomlSectionHeaderKey(section.header)) ||
          getProjectTrustLevel(section.block) === 'untrusted'
      )
      .map((section) => section.block)
  ])
}

function getTomlSections(config: string): TomlSection[] {
  const lines = config.split('\n')
  const sections: TomlSection[] = []
  let sectionStart = -1
  let sectionHeader: string | null = null
  let scanState = createTomlLineScanState()

  for (let index = 0; index < lines.length; index += 1) {
    const header = isTomlStructuralLine(scanState) ? getTomlTableHeader(lines[index] ?? '') : null
    if (!header) {
      scanState = updateTomlLineScanState(scanState, lines[index] ?? '')
      continue
    }

    if (sectionStart !== -1) {
      sections.push({
        header: sectionHeader ?? '',
        block: lines.slice(sectionStart, index).join('\n'),
        start: sectionStart
      })
    }
    sectionStart = index
    sectionHeader = header
    scanState = updateTomlLineScanState(scanState, lines[index] ?? '')
  }

  if (sectionStart !== -1) {
    sections.push({
      header: sectionHeader ?? '',
      block: lines.slice(sectionStart).join('\n'),
      start: sectionStart
    })
  }
  return sections
}

function isRuntimePreservedTomlSection(header: string): boolean {
  return isRuntimeHookTrustTomlSection(header) || isRuntimeProjectTomlSection(header)
}

function isRuntimeHookTrustTomlSection(header: string): boolean {
  return header.trimStart().startsWith('[hooks.state.')
}

function isRuntimeProjectTomlSection(header: string): boolean {
  return header.trimStart().startsWith('[projects.')
}

function getTomlSectionHeaderKey(header: string): string {
  return header.trim()
}

function getProjectTrustLevel(block: string): 'trusted' | 'untrusted' | null {
  const match =
    /^[ \t]*trust_level[ \t]*=[ \t]*(?:"(trusted|untrusted)"|'(trusted|untrusted)')[ \t\r]*(?:#.*)?$/m.exec(
      block
    )
  const trustLevel = match?.[1] ?? match?.[2] ?? null
  return trustLevel === 'trusted' || trustLevel === 'untrusted' ? trustLevel : null
}

function joinTomlBlocks(blocks: string[]): string {
  const normalizedBlocks = blocks.map((block) => block.trim()).filter((block) => block.length > 0)
  return normalizedBlocks.length === 0 ? '' : `${normalizedBlocks.join('\n\n')}\n`
}
