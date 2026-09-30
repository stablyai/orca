import { dirname, join } from 'node:path'
import { rewriteRelativePathConfigValues } from './codex-config-path-reference-rewrite'
import { escapeTomlBasicString } from './config-toml-syntax'
import {
  createTomlLineScanState,
  getTomlTableHeader,
  isTomlStructuralLine,
  parseTomlSingleLineStringValue,
  updateTomlLineScanState
} from './config-toml-line-scan'
import { normalizeDeprecatedCodexHookFeatureFlag } from './config-toml-deprecated-hook-flag'
import { parseWslUncPath } from '../../shared/wsl-paths'
import { quotePosixShell } from '../../shared/wsl-login-shell-command'
import { stripRuntimeOwnedTomlSections } from './config-toml-runtime-owned-sections'

export function resolveCodexConfigMirrorSourceDirectory(
  systemHomePath: string,
  systemConfigDir?: string
): string {
  return (
    systemConfigDir ??
    parseWslUncPath(systemHomePath)?.linuxPath ??
    dirname(join(systemHomePath, 'config.toml'))
  )
}

export function prepareSystemConfigForRuntimeMirror(
  config: string,
  systemConfigDir: string,
  runtimeHomePath?: string
): string {
  const prepared = rewriteRelativePathConfigValues(
    normalizeDeprecatedCodexHookFeatureFlag(config),
    systemConfigDir
  )
  return runtimeHomePath
    ? rebindAccountScopedMcpHeaderHelpers(prepared, systemConfigDir, runtimeHomePath)
    : prepared
}

// Why: trust blocks reference a hooks.json path, so system-home hook trust
// entries are not valid in a fresh runtime CODEX_HOME until install remaps
// them. Also seeds WSL runtime homes, where systemConfigDir must be the
// Linux-side ~/.codex the config resolves against inside the distro.
export function prepareSystemConfigForFreshRuntimeMirror(
  config: string,
  systemConfigDir: string,
  runtimeHomePath?: string
): string {
  return stripRuntimeOwnedTomlSections(
    prepareSystemConfigForRuntimeMirror(config, systemConfigDir, runtimeHomePath)
  )
}

function rebindAccountScopedMcpHeaderHelpers(
  config: string,
  systemConfigDir: string,
  runtimeHomePath: string
): string {
  const runtimePosixHome = parseWslUncPath(runtimeHomePath)?.linuxPath ?? runtimeHomePath
  if (!systemConfigDir.startsWith('/') || !runtimePosixHome.startsWith('/')) {
    return config
  }

  const lines = config.split('\n')
  let inMcpServer = false
  let scanState = createTomlLineScanState()
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? ''
    if (isTomlStructuralLine(scanState)) {
      const header = getTomlTableHeader(line)
      if (header) {
        inMcpServer = header.trim().startsWith('[mcp_servers.')
      } else if (inMcpServer && /^\s*http_headers_helper\s*=/.test(line)) {
        const parsed = parseTomlSingleLineStringValue(line, line.indexOf('=') + 1)
        if (parsed) {
          const sourceValues = [systemConfigDir, quotePosixShell(systemConfigDir)]
          for (const sourceValue of sourceValues) {
            const assignment = `CODEX_HOME=${sourceValue}`
            const at = parsed.value.indexOf(assignment)
            if (
              at !== -1 &&
              (at === 0 || /\s/.test(parsed.value[at - 1] ?? '')) &&
              (at + assignment.length === parsed.value.length ||
                /\s/.test(parsed.value[at + assignment.length] ?? ''))
            ) {
              const value = parsed.value.replace(
                assignment,
                `CODEX_HOME=${quotePosixShell(runtimePosixHome)}`
              )
              lines[index] =
                `${line.slice(0, parsed.start)}"${escapeTomlBasicString(value)}"${line.slice(parsed.end)}`
              break
            }
          }
        }
      }
    }
    scanState = updateTomlLineScanState(scanState, line)
  }
  return lines.join('\n')
}
