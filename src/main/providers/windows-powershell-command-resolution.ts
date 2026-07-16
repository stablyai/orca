import { readFileSync, statSync } from 'node:fs'
import { delimiter, extname, join } from 'node:path'

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile()
  } catch {
    return false
  }
}

function getPowerShellCommandNames(command: string, pathExt: string | null | undefined): string[] {
  const executableExtensions = (pathExt ?? '')
    .split(';')
    .map((extension) => extension.trim())
    .filter(Boolean)
    .map((extension) => (extension.startsWith('.') ? extension : `.${extension}`))
  return [
    `${command}.ps1`,
    ...executableExtensions.map((extension) => `${command}${extension}`),
    command
  ].filter(
    (name, index, names) =>
      names.findIndex((entry) => entry.toLowerCase() === name.toLowerCase()) === index
  )
}

/** Resolve the external command a fresh PowerShell would select from PATH. */
export function resolvePowerShellExternalCommand(args: {
  command: string
  pathEnv: string | null | undefined
  pathExt?: string | null
}): string | null {
  const names = getPowerShellCommandNames(args.command, args.pathExt)
  for (const rawDirectory of args.pathEnv?.split(delimiter) ?? []) {
    const directory = rawDirectory.trim().replace(/^"|"$/g, '')
    if (!directory) {
      continue
    }
    for (const name of names) {
      const candidate = join(directory, name)
      if (isFile(candidate)) {
        return candidate
      }
    }
  }
  return null
}

function normalizeShimNewlines(contents: string): string {
  return contents.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n')
}

// Why: bypassing PowerShell is safe only when the selected shim has no behavior
// beyond forwarding argv to the official Codex JavaScript entry point.
const NPM_CMD_SHIM_TEMPLATES = [
  String.raw`@ECHO off
GOTO start
:find_dp0
SET dp0=%~dp0
EXIT /b
:start
SETLOCAL
CALL :find_dp0

IF EXIST "%dp0%\node.exe" (
  SET "_prog=%dp0%\node.exe"
) ELSE (
  SET "_prog=node"
  SET PATHEXT=%PATHEXT:;.JS;=;%
)

endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\node_modules\@openai\codex\bin\codex.js" %*
`
]

const NPM_POWERSHELL_SHIM_TEMPLATES = [
  String.raw`#!/usr/bin/env pwsh
$basedir=Split-Path $MyInvocation.MyCommand.Definition -Parent

$exe=""
if ($PSVersionTable.PSVersion -lt "6.0" -or $IsWindows) {
  # Fix case when both the Windows and Linux builds of Node
  # are installed in the same directory
  $exe=".exe"
}
$ret=0
if (Test-Path "$basedir/node$exe") {
  # Support pipeline input
  if ($MyInvocation.ExpectingInput) {
    $input | & "$basedir/node$exe"  "$basedir/node_modules/@openai/codex/bin/codex.js" $args
  } else {
    & "$basedir/node$exe"  "$basedir/node_modules/@openai/codex/bin/codex.js" $args
  }
  $ret=$LASTEXITCODE
} else {
  # Support pipeline input
  if ($MyInvocation.ExpectingInput) {
    $input | & "node$exe"  "$basedir/node_modules/@openai/codex/bin/codex.js" $args
  } else {
    & "node$exe"  "$basedir/node_modules/@openai/codex/bin/codex.js" $args
  }
  $ret=$LASTEXITCODE
}
exit $ret
`
]

/** Accept only known package-manager shims with no additional executable statements. */
export function isCanonicalCodexPackageShim(commandPath: string): boolean {
  try {
    const contents = normalizeShimNewlines(readFileSync(commandPath, 'utf8'))
    const extension = extname(commandPath).toLowerCase()
    if (extension === '.cmd') {
      return NPM_CMD_SHIM_TEMPLATES.includes(contents)
    }
    return extension === '.ps1' && NPM_POWERSHELL_SHIM_TEMPLATES.includes(contents)
  } catch {
    return false
  }
}
