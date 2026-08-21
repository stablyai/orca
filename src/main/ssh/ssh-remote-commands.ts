import {
  RELAY_INSTALL_COMPLETE_FILENAME,
  relayArtifactFilenames
} from '../../shared/relay-artifacts'
import type { RemoteHostPlatform } from './ssh-remote-platform'
import { isWindowsRemoteHost, joinRemotePath, remoteDirname } from './ssh-remote-platform'
import { powerShellCommand, powerShellLiteral, powerShellNativeArg } from './ssh-remote-powershell'
import { shellEscape } from './ssh-connection-utils'

export function readRemoteHomeCommand(host: RemoteHostPlatform): string {
  if (!isWindowsRemoteHost(host)) {
    return 'echo $HOME'
  }
  return powerShellCommand("Write-Output ([Environment]::GetFolderPath('UserProfile'))")
}

export function makeRemoteDirectoryCommand(host: RemoteHostPlatform, remotePath: string): string {
  if (!isWindowsRemoteHost(host)) {
    return `mkdir -p ${shellEscape(remotePath)}`
  }
  // New-Item has no -LiteralPath parameter; using it breaks stock Windows PowerShell.
  return powerShellCommand(
    `$null = New-Item -ItemType Directory -Force -Path ${powerShellLiteral(remotePath)}`
  )
}

export function makeRemoteExecutableCommand(host: RemoteHostPlatform, remotePath: string): string {
  if (isWindowsRemoteHost(host)) {
    return powerShellCommand(`if (Test-Path -LiteralPath ${powerShellLiteral(remotePath)}) { }`)
  }
  return `chmod +x ${shellEscape(remotePath)} 2>/dev/null; true`
}

export function removeRemoteFileCommand(host: RemoteHostPlatform, remotePath: string): string {
  if (!isWindowsRemoteHost(host)) {
    return `rm -f ${shellEscape(remotePath)} 2>/dev/null; true`
  }
  return powerShellCommand(
    `Remove-Item -LiteralPath ${powerShellLiteral(remotePath)} -Force -ErrorAction SilentlyContinue`
  )
}

export function removeRemoteTreeCommand(host: RemoteHostPlatform, remotePath: string): string {
  if (!isWindowsRemoteHost(host)) {
    return `rm -rf ${shellEscape(remotePath)}`
  }
  return powerShellCommand(
    `Remove-Item -LiteralPath ${powerShellLiteral(remotePath)} -Recurse -Force -ErrorAction SilentlyContinue`
  )
}

export function moveRemoteTreeCommand(
  host: RemoteHostPlatform,
  sourcePath: string,
  destinationPath: string
): string {
  if (!isWindowsRemoteHost(host)) {
    return `mv ${shellEscape(sourcePath)} ${shellEscape(destinationPath)} 2>&1 && echo MOVED || echo BUSY`
  }
  return powerShellCommand(
    [
      'try {',
      `Move-Item -LiteralPath ${powerShellLiteral(sourcePath)} -Destination ${powerShellLiteral(destinationPath)} -ErrorAction Stop`,
      "'MOVED'",
      `} catch { 'BUSY' }`
    ].join('; ')
  )
}

export function promoteRemoteTreeContentsCommand(
  host: RemoteHostPlatform,
  sourcePath: string,
  destinationPath: string
): string {
  if (!isWindowsRemoteHost(host)) {
    return `cp -a ${shellEscape(sourcePath)}/. ${shellEscape(destinationPath)}/ && rm -rf ${shellEscape(sourcePath)}`
  }
  return powerShellCommand(
    `$ErrorActionPreference = 'Stop'; Get-ChildItem -LiteralPath ${powerShellLiteral(sourcePath)} -Force -ErrorAction Stop | Copy-Item -Destination ${powerShellLiteral(destinationPath)} -Recurse -Force -ErrorAction Stop; Remove-Item -LiteralPath ${powerShellLiteral(sourcePath)} -Recurse -Force -ErrorAction Stop`
  )
}

export function writeRemoteEmptyFileCommand(host: RemoteHostPlatform, remotePath: string): string {
  if (!isWindowsRemoteHost(host)) {
    return `touch ${shellEscape(remotePath)}`
  }
  return powerShellCommand(
    `Set-Content -LiteralPath ${powerShellLiteral(remotePath)} -Value '' -NoNewline`
  )
}

/**
 * A partial install must read as MISSING, so every file the manifest ships is
 * probed — not a hand-kept subset. A relay that advertises the AI Vault title
 * service but lacks the WSL transcript helper would otherwise pass this probe
 * and then answer WSL title requests with silence.
 */
export function probeRelayInstalledCommand(
  host: RemoteHostPlatform,
  remoteRelayDir: string
): string {
  const required = [
    ...relayArtifactFilenames(isWindowsRemoteHost(host)),
    RELAY_INSTALL_COMPLETE_FILENAME
  ].map((filename) => joinRemotePath(host, remoteRelayDir, filename))
  if (!isWindowsRemoteHost(host)) {
    const fileTests = required.map((path) => `&& test -f ${shellEscape(path)} `).join('')
    return `test -d ${shellEscape(remoteRelayDir)} ${fileTests}&& echo OK || echo MISSING`
  }
  return powerShellCommand(
    [
      `$dir = ${powerShellLiteral(remoteRelayDir)}`,
      `$required = @(${required.map((path) => powerShellLiteral(path)).join(', ')})`,
      '$ok = Test-Path -LiteralPath $dir -PathType Container',
      'foreach ($f in $required) { if (-not (Test-Path -LiteralPath $f -PathType Leaf)) { $ok = $false } }',
      "if ($ok) { 'OK' } else { 'MISSING' }"
    ].join('; ')
  )
}

export const MAX_RELAY_GC_LISTING_ENTRIES = 64

export function listRelayBaseDirsCommand(host: RemoteHostPlatform, baseDir: string): string {
  if (!isWindowsRemoteHost(host)) {
    const statusPrefix = '__ORCA_RELAY_GC_FIND_STATUS__'
    return [
      `base=${shellEscape(baseDir)}; [ -d "$base" ] || exit 0;`,
      `{ find "$base" -mindepth 1 -maxdepth 1 -type d -name 'relay-*' -print; status=$?; printf '\n${statusPrefix}%s\n' "$status"; } |`,
      String.raw`awk 'BEGIN { count=0; status=-1 } /^${statusPrefix}[0-9]+$/ { status=substr($0, ${statusPrefix.length + 1}); next } { name=$0; sub(/^.*\//, "", name); if (name ~ /^relay-(v?[0-9]+\.[0-9]+\.[0-9]+(\+[0-9a-f]+)?)(\.gc-tombstone\.[0-9]+\.[0-9]+)?$/ && count < ${MAX_RELAY_GC_LISTING_ENTRIES}) { entries[count++]=name } } END { if (status != 0) exit 1; for (i=0; i<count; i++) print entries[i] }'`
    ].join(' ')
  }
  return powerShellCommand(
    [
      "$ErrorActionPreference = 'Stop'",
      `$base = ${powerShellLiteral(baseDir)}`,
      'if (Test-Path -LiteralPath $base -PathType Container) {',
      "Get-ChildItem -LiteralPath $base -Directory -Filter 'relay-*' -ErrorAction Stop | Where-Object { $_.Name -match '^relay-(v?[0-9]+\\.[0-9]+\\.[0-9]+(\\+[0-9a-f]+)?)(\\.gc-tombstone\\.[0-9]+\\.[0-9]+)?$' } | Select-Object -First " +
        `${MAX_RELAY_GC_LISTING_ENTRIES} | ForEach-Object { $_.Name }`,
      '}'
    ].join('\n')
  )
}

export function probeDirectoryExistsCommand(host: RemoteHostPlatform, remotePath: string): string {
  if (!isWindowsRemoteHost(host)) {
    return `test -d ${shellEscape(remotePath)} && echo LOCKED || echo OPEN`
  }
  return powerShellCommand(
    `if (Test-Path -LiteralPath ${powerShellLiteral(remotePath)} -PathType Container) { 'LOCKED' } else { 'OPEN' }`
  )
}

export function probeFileExistsCommand(host: RemoteHostPlatform, remotePath: string): string {
  if (!isWindowsRemoteHost(host)) {
    return `test -f ${shellEscape(remotePath)} && echo COMPLETE || echo PARTIAL`
  }
  return powerShellCommand(
    `if (Test-Path -LiteralPath ${powerShellLiteral(remotePath)} -PathType Leaf) { 'COMPLETE' } else { 'PARTIAL' }`
  )
}

type WindowsRelayLivenessOptions = {
  nodePath: string
  pipePaths: string[]
}

export function relayLivenessProbeCommand(
  host: RemoteHostPlatform,
  dir: string,
  windowsOptions?: WindowsRelayLivenessOptions
): string {
  if (!isWindowsRemoteHost(host)) {
    return (
      `state=DEAD; for f in ${shellEscape(dir)}/relay-*.sock ${shellEscape(dir)}/relay.sock; do ` +
      `[ -S "$f" ] && state=ALIVE && break; ` +
      'done; echo "$state"'
    )
  }
  if (!windowsOptions) {
    return powerShellCommand("'ALIVE'")
  }
  const js = [
    'const fs=require("fs"),path=require("path"),net=require("net");',
    'const [dir,...seed]=process.argv.slice(1);',
    'const valid=/^\\\\\\\\[.?]\\\\pipe\\\\orca-relay-[0-9a-f]{20}$/i;',
    'const pipes=[];',
    'let markerCount=0;',
    'for(const p of seed){if(valid.test(p)&&!pipes.includes(p))pipes.push(p)}',
    'try{for(const name of fs.readdirSync(dir)){',
    'if(!name.startsWith(".windows-active-pipe-"))continue;',
    'markerCount++;',
    'const p=fs.readFileSync(path.join(dir,name),"utf8").trim();',
    'if(valid.test(p)&&!pipes.includes(p))pipes.push(p)',
    '}}catch{}',
    'if(markerCount===0&&pipes.length===0){process.stdout.write("ALIVE");process.exit(0)}',
    'let i=0;',
    'function done(ok){process.stdout.write(ok?"ALIVE":"WAITING")}',
    'function next(){',
    'const pipe=pipes[i++];',
    'if(!pipe)return done(false);',
    'const s=net.connect(pipe);',
    'let settled=false;',
    'function finish(ok){if(settled)return;settled=true;s.destroy();if(ok)done(true);else next()}',
    's.setTimeout(200);',
    's.on("connect",()=>finish(true));',
    's.on("timeout",()=>finish(false));',
    's.on("error",()=>finish(false));',
    '}',
    'next();'
  ].join('')
  return commandWithNodePath(
    host,
    windowsOptions.nodePath,
    dir,
    [
      `& ${powerShellLiteral(windowsOptions.nodePath)}`,
      '-e',
      powerShellNativeArg(js),
      powerShellNativeArg(dir),
      ...windowsOptions.pipePaths.map((pipePath) => powerShellNativeArg(pipePath))
    ].join(' ')
  )
}

export function commandInRemoteDirectory(
  host: RemoteHostPlatform,
  remoteDir: string,
  command: string
): string {
  if (!isWindowsRemoteHost(host)) {
    return `cd ${shellEscape(remoteDir)} && ${command}`
  }
  return powerShellCommand(
    `Set-Location -ErrorAction Stop -LiteralPath ${powerShellLiteral(remoteDir)}; ${command}`
  )
}

export function commandWithNodePath(
  host: RemoteHostPlatform,
  nodePath: string,
  remoteDir: string,
  command: string
): string {
  const nodeBinDir = remoteDirname(nodePath, host)
  if (!isWindowsRemoteHost(host)) {
    return `export PATH=${shellEscape(nodeBinDir)}:$PATH && cd ${shellEscape(remoteDir)} && ${command}`
  }
  const windowsNodeBinDir = nodeBinDir.replace(/\//g, '\\')
  return powerShellCommand(
    [
      `$env:PATH = ${powerShellLiteral(windowsNodeBinDir)} + ';' + $env:PATH`,
      `Set-Location -ErrorAction Stop -LiteralPath ${powerShellLiteral(remoteDir)}`,
      command
    ].join('; ')
  )
}
