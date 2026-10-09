import { posix as posixPath } from 'node:path'
import { shellEscape } from './ssh-connection-utils'
import { powerShellLiteral } from './ssh-remote-powershell'

/** The host-Node floor for both the npm path and rung C (design D6). */
export const MIN_HOST_NODE_MAJOR = 24
const NODE_VERSION_MARKER = '__ORCA_NODE_VERSION__'
const NPM_VERSION_MARKER = '__ORCA_NPM_VERSION__'
const NAPI_VERSION_MARKER = '__ORCA_NAPI_VERSION__'

/**
 * `npm` installs native deps on the host; `addon-only` loads Orca's prebuilt N-API addons,
 * so it needs a Node and its N-API level but never npm (design D6 rung C).
 */
export type NodeToolchainRequirement = 'npm' | 'addon-only'

export function buildPosixNodeToolchainProbe(
  nodePath: string,
  requirement: NodeToolchainRequirement = 'npm'
): string {
  const nodeBinDir = posixPath.dirname(nodePath)
  const node = shellEscape(nodePath)
  if (requirement === 'addon-only') {
    // Why `|| true`: a Node that cannot run is an answer ("not this one"), not a lost channel.
    return `${[
      `printf '%s\\n' '${NODE_VERSION_MARKER}'`,
      `${node} --version`,
      `printf '%s\\n' '${NAPI_VERSION_MARKER}'`,
      `${node} -p process.versions.napi`
    ].join(' && ')} || true`
  }
  return [
    `printf '%s\\n' '${NODE_VERSION_MARKER}'`,
    `${node} --version`,
    `printf '%s\\n' '${NPM_VERSION_MARKER}'`,
    // Why: deploy prepends nodeBinDir before running bare npm; requiring a
    // colocated executable rejects valid split layouts (#9165).
    `PATH=${shellEscape(nodeBinDir)}:$PATH npm --version`
  ].join(' && ')
}

export function buildWindowsNodeToolchainProbe(nodePath: string): string {
  const nodeBinDir = posixPath.dirname(nodePath)
  const windowsNodeBinDir = nodeBinDir.replace(/\//g, '\\')
  return [
    // Why: mirror deploy's PATH-prepend + bare npm resolution so split
    // Node/npm layouts are not rejected solely for lacking npm.cmd (#9165).
    `$env:PATH = ${powerShellLiteral(windowsNodeBinDir)} + ';' + $env:PATH`,
    `Write-Output ${powerShellLiteral(NODE_VERSION_MARKER)}`,
    `& ${powerShellLiteral(nodePath)} --version`,
    'if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }',
    `Write-Output ${powerShellLiteral(NPM_VERSION_MARKER)}`,
    '& npm --version',
    'exit $LASTEXITCODE'
  ].join('; ')
}

export function nodeToolchainVersionsMeetRequirements(versionOutput: string): boolean {
  const nodeMajor = markedVersion(versionOutput, NODE_VERSION_MARKER)?.major ?? null
  const npmMajor = markedVersion(versionOutput, NPM_VERSION_MARKER)?.major ?? null
  if (versionOutput.includes(NODE_VERSION_MARKER)) {
    return nodeMajor !== null && nodeMajor >= MIN_HOST_NODE_MAJOR && npmMajor !== null
  }

  // Why: existing proxy integrations and tests may return only the Node
  // version even though production probes now emit both version markers.
  const legacyMatch = versionOutput.trim().match(/^v?(\d+)/)
  return legacyMatch ? Number.parseInt(legacyMatch[1]!, 10) >= MIN_HOST_NODE_MAJOR : false
}

export type HostNodeVersion = { major: number; minor: number }

export type HostNodeAddonFacts = { version: HostNodeVersion; napi: number }

/** The addon-only probe's answer, or null when the Node did not print both facts. */
export function parseHostNodeAddonFacts(output: string): HostNodeAddonFacts | null {
  const version = markedVersion(output, NODE_VERSION_MARKER)
  const napi = markedInteger(output, NAPI_VERSION_MARKER)
  return version && napi !== null ? { version, napi } : null
}

export function hostNodeMeetsAddonRequirements(
  facts: HostNodeAddonFacts | null,
  requiredNapi: number
): boolean {
  return facts !== null && facts.version.major >= MIN_HOST_NODE_MAJOR && facts.napi >= requiredNapi
}

function linesAfterMarker(output: string, marker: string): string[] | null {
  const lines = output.split(/\r?\n/)
  const markerIndex = lines.indexOf(marker)
  if (markerIndex === -1) {
    return null
  }
  const rest = lines.slice(markerIndex + 1)
  const next = rest.findIndex((line) => line.startsWith('__ORCA_'))
  return next === -1 ? rest : rest.slice(0, next)
}

function markedVersion(output: string, marker: string): HostNodeVersion | null {
  for (const line of linesAfterMarker(output, marker) ?? []) {
    const match = line.trim().match(/^v?(\d+)(?:\.(\d+))(?:\.\d+)?(?:[-+].*)?$/)
    if (match) {
      return { major: Number.parseInt(match[1]!, 10), minor: Number.parseInt(match[2]!, 10) }
    }
  }
  return null
}

function markedInteger(output: string, marker: string): number | null {
  for (const line of linesAfterMarker(output, marker) ?? []) {
    const match = line.trim().match(/^(\d+)$/)
    if (match) {
      return Number.parseInt(match[1]!, 10)
    }
  }
  return null
}
