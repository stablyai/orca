$ErrorActionPreference = 'Stop'
. "$PSScriptRoot/signature-policy.ps1"
$env:ORCA_WIN_UNINSTALLER_SIGNED_PATH = Join-Path $env:RUNNER_TEMP 'uninstaller-signing/signed/orca-uninstaller.exe'
if (-not (Test-Path -LiteralPath $env:ORCA_WIN_UNINSTALLER_SIGNED_PATH)) { throw 'Missing signed NSIS uninstaller.' }
Assert-SigningCertificate (Get-AuthenticodeSignature -FilePath $env:ORCA_WIN_UNINSTALLER_SIGNED_PATH) 'Uninstall Orca.exe'
$receipt = "$env:ORCA_WIN_UNINSTALLER_SIGNED_PATH.embedded-sha256"
if (Test-Path -LiteralPath $receipt) { Remove-Item -LiteralPath $receipt -Force }
pnpm exec electron-builder --config "$PSScriptRoot/electron-builder-signing.config.cjs" --win --publish never --prepackaged "$env:GITHUB_WORKSPACE/dist/win-unpacked"
if ($LASTEXITCODE -ne 0) { throw 'The signed NSIS rebuild failed.' }
if (-not (Test-Path 'dist/orca-windows-setup.exe')) { throw 'The NSIS rebuild did not produce an installer.' }
& "$PSScriptRoot/verify-uninstaller.ps1"
