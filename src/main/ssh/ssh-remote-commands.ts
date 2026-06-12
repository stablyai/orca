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

export function writeRemoteEmptyFileCommand(host: RemoteHostPlatform, remotePath: string): string {
  if (!isWindowsRemoteHost(host)) {
    return `touch ${shellEscape(remotePath)}`
  }
  return powerShellCommand(
    `Set-Content -LiteralPath ${powerShellLiteral(remotePath)} -Value '' -NoNewline`
  )
}

export function probeRelayInstalledCommand(
  host: RemoteHostPlatform,
  remoteRelayDir: string
): string {
  const relayJs = joinRemotePath(host, remoteRelayDir, 'relay.js')
  const installComplete = joinRemotePath(host, remoteRelayDir, '.install-complete')
  if (!isWindowsRemoteHost(host)) {
    return (
      `test -d ${shellEscape(remoteRelayDir)} ` +
      `&& test -f ${shellEscape(relayJs)} ` +
      `&& test -f ${shellEscape(installComplete)} ` +
      `&& echo OK || echo MISSING`
    )
  }
  return powerShellCommand(
    [
      `$dir = ${powerShellLiteral(remoteRelayDir)}`,
      `$relay = ${powerShellLiteral(relayJs)}`,
      `$complete = ${powerShellLiteral(installComplete)}`,
      "if ((Test-Path -LiteralPath $dir -PathType Container) -and (Test-Path -LiteralPath $relay -PathType Leaf) -and (Test-Path -LiteralPath $complete -PathType Leaf)) { 'OK' } else { 'MISSING' }"
    ].join('; ')
  )
}

export function acquireInstallLockParentCommand(
  host: RemoteHostPlatform,
  remoteRelayDir: string
): string {
  return makeRemoteDirectoryCommand(host, remoteRelayDir)
}

export function tryCreateInstallLockCommand(host: RemoteHostPlatform, lockDir: string): string {
  if (!isWindowsRemoteHost(host)) {
    return `mkdir ${shellEscape(lockDir)} 2>&1 && echo OK || echo BUSY`
  }
  // New-Item has no -LiteralPath parameter; using it breaks stock Windows PowerShell.
  return powerShellCommand(
    `$ErrorActionPreference = "Stop"; try { $null = New-Item -ItemType Directory -Path ${powerShellLiteral(lockDir)}; 'OK' } catch { 'BUSY' }`
  )
}

export function lockMtimeEpochCommand(host: RemoteHostPlatform, lockDir: string): string {
  if (!isWindowsRemoteHost(host)) {
    return `stat -c %Y ${shellEscape(lockDir)} 2>/dev/null || stat -f %m ${shellEscape(lockDir)} 2>/dev/null || echo`
  }
  return powerShellCommand(
    [
      `$item = Get-Item -LiteralPath ${powerShellLiteral(lockDir)} -ErrorAction Stop`,
      '$dto = [DateTimeOffset]$item.LastWriteTimeUtc',
      'Write-Output $dto.ToUnixTimeSeconds()'
    ].join('; ')
  )
}

export function listRelayBaseDirsCommand(host: RemoteHostPlatform, baseDir: string): string {
  if (!isWindowsRemoteHost(host)) {
    return `ls -1 ${shellEscape(baseDir)} 2>/dev/null || true`
  }
  return powerShellCommand(
    [
      `$base = ${powerShellLiteral(baseDir)}`,
      'if (Test-Path -LiteralPath $base -PathType Container) {',
      'Get-ChildItem -LiteralPath $base -Directory | ForEach-Object { $_.Name }',
      '}'
    ].join(' ')
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
      `for f in ${shellEscape(dir)}/relay-*.sock ${shellEscape(dir)}/relay.sock; do ` +
      `[ -S "$f" ] && echo ALIVE && break; ` +
      'done; true'
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
