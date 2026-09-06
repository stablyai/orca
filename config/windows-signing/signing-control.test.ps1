$ErrorActionPreference = 'Stop'
. "$PSScriptRoot/signature-policy.ps1"
$script:passed = 0
function Test-Case([string]$name, [scriptblock]$body) {
  & $body
  $script:passed++
  Write-Host "PASS $name"
}
function Assert-Throws([scriptblock]$body, [string]$message) {
  try { & $body 6> $null } catch {
    if ("$_" -notlike "*$message*") { throw "Expected '$message', received '$_'" }
    return
  }
  throw "Expected rejection: $message"
}
$signature = [pscustomobject]@{ Status = 'Valid'; SignerCertificate = [pscustomobject]@{ Subject = 'CN=SignPath Foundation'; Thumbprint = 'a' * 40 } }
Test-Case 'production certificate accepted' {
  $env:SIGNING_POLICY = 'release-signing'
  Assert-SigningCertificate $signature 'Orca.exe'
}
Test-Case 'production rejects untrusted certificate' {
  $signature.Status = 'NotTrusted'
  Assert-Throws { Assert-SigningCertificate $signature 'Orca.exe' } 'Invalid production'
}
Test-Case 'test certificate must be pinned' {
  $env:SIGNING_POLICY = 'test-signing'
  $env:TEST_CERTIFICATE_THUMBPRINT = 'b' * 40
  Assert-Throws { Assert-SigningCertificate $signature 'Orca.exe' } 'Unexpected rehearsal'
  $env:TEST_CERTIFICATE_THUMBPRINT = 'a' * 40
  Assert-SigningCertificate $signature 'Orca.exe'
  $signature.Status = 'HashMismatch'
  Assert-Throws { Assert-SigningCertificate $signature 'Orca.exe' } 'Unexpected rehearsal'
  $signature.Status = 'NotTrusted'
}
Test-Case 'unknown policy rejected' {
  $env:SIGNING_POLICY = 'unknown'
  Assert-Throws { Assert-SigningCertificate $signature 'Orca.exe' } 'Unknown signing'
}
$control = $PSScriptRoot
$original = Get-Location
$temporary = Join-Path ([IO.Path]::GetTempPath()) "orca-signing-test-$([guid]::NewGuid())"
New-Item -ItemType Directory $temporary | Out-Null
try {
  Set-Location $temporary
  $env:SIGNING_POLICY = 'test-signing'
  $env:GITHUB_STEP_SUMMARY = Join-Path $temporary 'summary.txt'
  $global:OrcaSigningTestBadSignature = $false
  function Get-AuthenticodeSignature { param($FilePath)
    if ($global:OrcaSigningTestBadSignature) { return [pscustomobject]@{ Status = 'HashMismatch'; SignerCertificate = $signature.SignerCertificate } }
    return $signature
  }
  $command = Get-Command 7z, 7zz -ErrorAction SilentlyContinue | Select-Object -First 1
  if (-not $command -and $IsWindows) { $command = Get-Item 'C:/Program Files/7-Zip/7z.exe' }
  if (-not $command) { throw 'Install 7-Zip to exercise real nested installer archive extraction.' }
  $global:OrcaSigningTestExtractor = if ($command.Source) { $command.Source } else { $command.FullName }
  function node { $global:LASTEXITCODE = 0; return $global:OrcaSigningTestExtractor }
  New-Item -ItemType Directory -Force 'app-fixture/resources', 'outer-fixture/$PLUGINSDIR', 'dist/win-unpacked', 'signed-inner' | Out-Null
  Set-Content 'app-fixture/Orca.exe' 'fixture'
  Set-Content 'app-fixture/resources/elevate.exe' 'fixture'
  Set-Content 'inner-signing-list.txt' 'Orca.exe'
  function New-TestInstaller {
    Remove-Item 'outer-fixture/$PLUGINSDIR/app-64.7z', 'dist/orca-windows-setup.exe' -ErrorAction SilentlyContinue
    & $global:OrcaSigningTestExtractor a 'outer-fixture/$PLUGINSDIR/app-64.7z' './app-fixture/*' | Out-Null
    if ($LASTEXITCODE -ne 0) { throw 'Cannot create application archive fixture.' }
    & $global:OrcaSigningTestExtractor a -t7z 'dist/orca-windows-setup.exe' './outer-fixture/*' | Out-Null
    if ($LASTEXITCODE -ne 0) { throw 'Cannot create outer archive fixture.' }
  }
  New-TestInstaller
  Test-Case 'shipped payload signatures verified' { & "$control/verify-inner.ps1" }
  Test-Case 'tampered payload blocks release and retains evidence' {
    $global:OrcaSigningTestBadSignature = $true
    Assert-Throws { & "$control/verify-inner.ps1" } 'incorrectly signed'
    if ((Get-Content 'inner-signing-evidence.txt' -Raw) -notlike '*VERDICT: FAILED*') { throw 'Failure evidence missing' }
    $global:OrcaSigningTestBadSignature = $false
  }
  Test-Case 'missing elevate blocks release' {
    Remove-Item 'app-fixture/resources/elevate.exe'
    New-TestInstaller
    Assert-Throws { & "$control/verify-inner.ps1" } 'missing or incorrectly'
  }
  Test-Case 'extractor failure blocks release' {
    Set-Content 'extractor.ps1' '$global:LASTEXITCODE = 9'
    $global:OrcaSigningTestExtractor = Join-Path $temporary 'extractor.ps1'
    Assert-Throws { & "$control/verify-inner.ps1" } 'Cannot extract'
  }
  Test-Case 'resolver failure blocks release before extraction' {
    function node { $global:LASTEXITCODE = 7; return 'invalid' }
    Assert-Throws { & "$control/verify-inner.ps1" } 'Cannot resolve'
  }
  Test-Case 'suffix-only signed paths rejected' {
    Set-Content 'signed-inner/not-Orca.exe' 'fixture'
    Assert-Throws { & "$control/restore-inner.ps1" } 'did not round-trip'
  }
  Test-Case 'exact signed path restored' {
    Set-Content 'signed-inner/Orca.exe' 'signed-fixture'
    & "$control/restore-inner.ps1"
    if ((Get-Content 'dist/win-unpacked/Orca.exe') -ne 'signed-fixture') { throw 'Restore failed' }
  }
  $env:RUNNER_TEMP = Join-Path $temporary 'runner'
  New-Item -ItemType Directory -Force 'signed-inner/uninstaller' | Out-Null
  Test-Case 'missing signed uninstaller blocks rebuild' {
    Assert-Throws { & "$control/restore-uninstaller.ps1" } 'SignPath must return'
  }
  Set-Content 'signed-inner/uninstaller/orca-uninstaller.exe' 'signed-uninstaller'
  Test-Case 'signed uninstaller restored outside checkout' { & "$control/restore-uninstaller.ps1" }
  $signedUninstaller = Join-Path $env:RUNNER_TEMP 'uninstaller-signing/signed/orca-uninstaller.exe'
  Test-Case 'missing embedding receipt blocks publication' {
    Assert-Throws { & "$control/verify-uninstaller.ps1" } 'must embed'
  }
  Test-Case 'wrong embedding receipt blocks publication' {
    Set-Content "$signedUninstaller.embedded-sha256" ('a' * 64)
    Assert-Throws { & "$control/verify-uninstaller.ps1" } 'does not match'
  }
  (Get-FileHash -LiteralPath $signedUninstaller -Algorithm SHA256).Hash.ToLowerInvariant() | Set-Content "$signedUninstaller.embedded-sha256"
  Test-Case 'signed uninstaller and embedding receipt verified' { & "$control/verify-uninstaller.ps1" }
  Test-Case 'bad uninstaller signature blocks publication' {
    $global:OrcaSigningTestBadSignature = $true
    Assert-Throws { & "$control/verify-uninstaller.ps1" } 'Unexpected rehearsal'
    $global:OrcaSigningTestBadSignature = $false
  }
  $env:GITHUB_WORKSPACE = $temporary
  $env:GITHUB_REPOSITORY = 'stablyai/orca'
  $env:GITHUB_RUN_ID = '123'
  $env:GITHUB_RUN_ATTEMPT = '1'
  $env:GITHUB_WORKFLOW_SHA = 'a' * 40
  $env:GITHUB_SHA = 'a' * 40
  $env:TAG = 'v1.0.0'
  $env:STAGE = 'inner'
  $env:MODE = 'save'
  $env:REQUEST_ID = '11111111-1111-4111-8111-111111111111'
  $env:LOCALAPPDATA = Join-Path $temporary 'local'
  $env:ELECTRON_BUILDER_CACHE = "$env:LOCALAPPDATA/electron-builder/Cache"
  $env:GITHUB_ENV = Join-Path $temporary 'github-env'
  New-Item -ItemType Directory -Force "$env:LOCALAPPDATA/electron-builder/Cache/nsis@1.2.1/nsis-bundle" | Out-Null
  Set-Content "$env:LOCALAPPDATA/electron-builder/Cache/nsis@1.2.1/nsis-bundle/elevate.exe" 'cache'
  Set-Content 'dist/orca-windows-setup.exe' 'installer'
  Set-Content 'dist/latest.yml' 'metadata'
  function git { $global:LASTEXITCODE = 0; return ('b' * 40) }
  Test-Case 'first attempt checkpoints exact build' { & "$control/checkpoint.ps1" }
  Test-Case 'rerun cannot save or resubmit' {
    $env:GITHUB_RUN_ATTEMPT = '2'
    Assert-Throws { & "$control/checkpoint.ps1" } 'Never create'
  }
  Copy-Item 'signing-checkpoint' 'original-checkpoint' -Recurse
  $env:MODE = 'restore'
  function gh {
    $global:LASTEXITCODE = 0
    if ($args[0] -eq 'api') {
      return (@{total_count = 1; artifacts = @(@{name = "orca-signing-$env:STAGE-123-1-$env:REQUEST_ID"; expired = $false; workflow_run = @{id = 123; head_sha = $env:GITHUB_SHA}})} | ConvertTo-Json -Depth 5)
    }
    Copy-Item 'original-checkpoint' 'signing-checkpoint' -Recurse
  }
  Test-Case 'rerun restores original build and request' {
    & "$control/checkpoint.ps1"
    if ((Get-Content $env:GITHUB_ENV -Raw) -notlike "*SIGNPATH_REQUEST_ID=$env:REQUEST_ID*") { throw 'Request identity missing' }
  }
  Test-Case 'installer checkpoint restores receipt and versioned tool cache on a fresh runner' {
    $env:MODE = 'save'
    $env:STAGE = 'installer'
    $env:GITHUB_RUN_ATTEMPT = '1'
    & "$control/checkpoint.ps1"
    Remove-Item 'original-checkpoint' -Recurse -Force
    Copy-Item 'signing-checkpoint' 'original-checkpoint' -Recurse
    Remove-Item "$env:RUNNER_TEMP/uninstaller-signing" -Recurse -Force
    Remove-Item $env:ELECTRON_BUILDER_CACHE -Recurse -Force
    $env:MODE = 'restore'
    $env:GITHUB_RUN_ATTEMPT = '2'
    & "$control/checkpoint.ps1"
    & "$control/verify-uninstaller.ps1"
    if (-not (Test-Path "$env:ELECTRON_BUILDER_CACHE/nsis@1.2.1/nsis-bundle/elevate.exe")) { throw 'Versioned tool cache lost on resume' }
  }
  Test-Case 'corrupt checkpoint rejected' {
    Add-Content 'original-checkpoint/checkpoint.tar.gz' 'corrupt'
    Assert-Throws { & "$control/checkpoint.ps1" } 'SHA-256 mismatch'
  }
} finally {
  Set-Location $original
  Remove-Item -LiteralPath $temporary -Recurse -Force
}
Write-Host "$script:passed signing control tests passed."
