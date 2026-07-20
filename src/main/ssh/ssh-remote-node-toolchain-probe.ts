import { posix as posixPath } from 'node:path'
import { shellEscape } from './ssh-connection-utils'
import { powerShellLiteral } from './ssh-remote-powershell'

const MIN_NODE_MAJOR = 18
const NODE_VERSION_MARKER = '__ORCA_NODE_VERSION__'
const NPM_VERSION_MARKER = '__ORCA_NPM_VERSION__'

export function buildPosixNodeToolchainProbe(nodePath: string): string {
  const nodeBinDir = posixPath.dirname(nodePath)
  return [
    `printf '%s\\n' '${NODE_VERSION_MARKER}'`,
    `${shellEscape(nodePath)} --version`,
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
  const nodeMajor = markedVersionMajor(versionOutput, NODE_VERSION_MARKER)
  const npmMajor = markedVersionMajor(versionOutput, NPM_VERSION_MARKER)
  if (versionOutput.includes(NODE_VERSION_MARKER)) {
    return nodeMajor !== null && nodeMajor >= MIN_NODE_MAJOR && npmMajor !== null
  }

  // Why: existing proxy integrations and tests may return only the Node
  // version even though production probes now emit both version markers.
  const legacyMatch = versionOutput.trim().match(/^v?(\d+)/)
  return legacyMatch ? Number.parseInt(legacyMatch[1]!, 10) >= MIN_NODE_MAJOR : false
}

function markedVersionMajor(output: string, marker: string): number | null {
  const lines = output.split(/\r?\n/)
  const markerIndex = lines.indexOf(marker)
  if (markerIndex < 0) {
    return null
  }
  for (const line of lines.slice(markerIndex + 1)) {
    if (line.startsWith('__ORCA_')) {
      return null
    }
    const match = line.trim().match(/^v?(\d+)(?:\.\d+){1,2}(?:[-+].*)?$/)
    if (match) {
      return Number.parseInt(match[1]!, 10)
    }
  }
  return null
}
