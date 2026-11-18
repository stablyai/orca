#Requires -Version 5.1
<#
.SYNOPSIS
  Prepares a Windows machine to build and test Zotz from source.

.DESCRIPTION
  Only developers need this; the installed Zotz ships its native modules already compiled.
  Each step checks first and installs only what is missing (winget asks for admin when needed),
  so running it again changes nothing. See docs/zotz/UPDATE.md, "Construir desde el código".

  Steps: winget, Node 24, pnpm (corepack), Python 3 (node-gyp), Visual Studio Build Tools with
  the C++ workload, Rust (Windows CLI launcher), then pnpm install and a native-module build check.

.PARAMETER CheckOnly
  Report what is installed and what is missing without installing anything.
#>
param([switch]$CheckOnly)

$ErrorActionPreference = 'Stop'
$RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..\..\..')).Path
$results = [System.Collections.Generic.List[object]]::new()

function Write-Step([string]$Name, [string]$Status, [string]$Detail) {
    $results.Add([pscustomobject]@{ Step = $Name; Status = $Status; Detail = $Detail })
    $color = switch ($Status) { 'ok' { 'Green' } 'installed' { 'Cyan' } 'missing' { 'Yellow' } default { 'Red' } }
    Write-Host ("[{0,-9}] {1} {2}" -f $Status, $Name, $Detail) -ForegroundColor $color
}

# Installers add to PATH in the registry; this session only sees it after a reload.
function Update-SessionPath {
    $machine = [Environment]::GetEnvironmentVariable('Path', 'Machine')
    $user = [Environment]::GetEnvironmentVariable('Path', 'User')
    $env:Path = "$machine;$user"
}

function Test-CommandExists([string]$Name) {
    return [bool](Get-Command $Name -ErrorAction SilentlyContinue)
}

function Install-WingetPackage([string]$Id, [string[]]$ExtraArgs = @()) {
    $arguments = @('install', '--id', $Id, '-e', '--accept-package-agreements', '--accept-source-agreements') + $ExtraArgs
    & winget @arguments
    if ($LASTEXITCODE -ne 0) {
        throw "winget install $Id failed (exit $LASTEXITCODE)"
    }
    Update-SessionPath
}

function Ensure-Tool([string]$Name, [scriptblock]$Probe, [scriptblock]$Install) {
    $found = & $Probe
    if ($found) {
        Write-Step $Name 'ok' $found
        return $true
    }
    if ($CheckOnly) {
        Write-Step $Name 'missing' ''
        return $false
    }
    try {
        & $Install
        $found = & $Probe
        if ($found) {
            Write-Step $Name 'installed' $found
            return $true
        }
        Write-Step $Name 'failed' 'installed but still not found; open a new terminal and run this script again'
    } catch {
        Write-Step $Name 'failed' $_.Exception.Message
    }
    return $false
}

if (-not (Test-CommandExists 'winget')) {
    Write-Step 'winget' 'failed' 'install "App Installer" from the Microsoft Store, then run this again'
    exit 1
}
Write-Step 'winget' 'ok' ''

$nodeOk = Ensure-Tool 'Node 24' {
    if (Test-CommandExists 'node') {
        $version = (& node --version).Trim()
        if ($version -match '^v24\.') { return $version }
    }
    return $null
} { Install-WingetPackage 'OpenJS.NodeJS.LTS' }

# corepack ships with Node and pins the pnpm version from package.json; no global install needed.
$pnpmOk = $nodeOk -and (Ensure-Tool 'pnpm (corepack)' {
        try { return "pnpm $((& corepack pnpm --version 2>$null | Select-Object -Last 1).Trim())" } catch { return $null }
    } { & corepack prepare --activate 2>$null })

$pythonOk = Ensure-Tool 'Python 3 (node-gyp)' {
    foreach ($candidate in @('python', 'py')) {
        if (Test-CommandExists $candidate) {
            $version = (& $candidate --version 2>&1 | Out-String).Trim()
            if ($version -match '^Python 3\.') { return $version }
        }
    }
    return $null
} { Install-WingetPackage 'Python.Python.3.12' }

# node-gyp finds the compiler through vswhere; the C++ x64 tools component is what it needs.
$buildToolsOk = Ensure-Tool 'Visual Studio Build Tools (C++)' {
    $vswhere = Join-Path ${env:ProgramFiles(x86)} 'Microsoft Visual Studio\Installer\vswhere.exe'
    if (-not (Test-Path $vswhere)) { return $null }
    $path = & $vswhere -latest -products * -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath
    if ($path) { return "$path".Trim() }
    return $null
} {
    Install-WingetPackage 'Microsoft.VisualStudio.2022.BuildTools' @(
        '--override', '--passive --wait --add Microsoft.VisualStudio.Workload.VCTools --includeRecommended'
    )
}

$rustOk = Ensure-Tool 'Rust (cargo)' {
    if (Test-CommandExists 'cargo') { return (& cargo --version).Trim() }
    $cargo = Join-Path $env:USERPROFILE '.cargo\bin\cargo.exe'
    if (Test-Path $cargo) { return (& $cargo --version).Trim() }
    return $null
} {
    Install-WingetPackage 'Rustlang.Rustup'
    $rustup = Join-Path $env:USERPROFILE '.cargo\bin\rustup.exe'
    if (Test-Path $rustup) { & $rustup default stable }
}

if ($CheckOnly) {
    Write-Host ''
    Write-Host 'Check only: nothing was installed.'
} elseif ($nodeOk -and $pnpmOk -and $pythonOk -and $buildToolsOk) {
    Push-Location $RepoRoot
    try {
        Write-Host ''
        Write-Host 'Installing dependencies (pnpm install)...'
        & corepack pnpm install
        if ($LASTEXITCODE -ne 0) { throw "pnpm install failed (exit $LASTEXITCODE)" }
        Write-Step 'pnpm install' 'ok' ''
        & node config/scripts/native-build/node-addons/ensure-native-runtime.mjs --runtime=node
        if ($LASTEXITCODE -ne 0) { throw "native modules did not build (exit $LASTEXITCODE)" }
        Write-Step 'native modules' 'ok' 'node-pty and the Windows addons build'
    } catch {
        Write-Step 'project' 'failed' $_.Exception.Message
    } finally {
        Pop-Location
    }
} else {
    Write-Step 'project' 'missing' 'fix the steps above first'
}

Write-Host ''
$results | Format-Table -AutoSize | Out-String | Write-Host
if (-not $rustOk) {
    Write-Host 'Rust is only needed to build the Windows CLI launcher (pnpm build:win).'
}
$failed = @($results | Where-Object { $_.Status -eq 'failed' -or ($_.Status -eq 'missing' -and $_.Step -ne 'Rust (cargo)') })
if ($failed.Count -gt 0) { exit 1 }
