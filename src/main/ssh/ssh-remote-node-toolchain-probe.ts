import { posix as posixPath } from 'node:path'
import { quotePosixShell } from '../../shared/shell-argument-quoting'
import { quotePowerShellLiteral as powerShellLiteral } from '../../shared/powershell-native-argument'

const MIN_HOST_NODE_MAJOR = 18
const NODE_VERSION_MARKER = '__ORCA_NODE_VERSION__'
const NPM_VERSION_MARKER = '__ORCA_NPM_VERSION__'

export function buildPosixNodeToolchainProbe(nodePath: string): string {
  const nodeBinDir = posixPath.dirname(nodePath)
  const node = quotePosixShell(nodePath)
  return [
    `printf '%s\\n' '${NODE_VERSION_MARKER}'`,
    `${node} --version`,
    `printf '%s\\n' '${NPM_VERSION_MARKER}'`,
    // Match deploy's prepended PATH and bare npm; valid split Node/npm layouts need no colocation (#9165).
    `PATH=${quotePosixShell(nodeBinDir)}:$PATH npm --version`
  ].join(' && ')
}

export function buildWindowsNodeToolchainProbe(nodePath: string): string {
  const nodeBinDir = posixPath.dirname(nodePath)
  const windowsNodeBinDir = nodeBinDir.replace(/\//g, '\\')
  return [
    // Mirror deploy PATH resolution so split Windows layouts need no colocated npm.cmd (#9165).
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

  // Retain compatibility with proxy/test answers that report only Node version.
  const legacyMatch = versionOutput.trim().match(/^v?(\d+)/)
  return legacyMatch ? Number.parseInt(legacyMatch[1]!, 10) >= MIN_HOST_NODE_MAJOR : false
}

type HostNodeVersion = { major: number; minor: number }

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
