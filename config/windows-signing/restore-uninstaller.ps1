$ErrorActionPreference = 'Stop'
. "$PSScriptRoot/signature-policy.ps1"
$signed = 'signed-inner/uninstaller/orca-uninstaller.exe'
if (-not (Test-Path -LiteralPath $signed -PathType Leaf)) {
  throw 'SignPath must return uninstaller/orca-uninstaller.exe; include it in windows-inner-binaries-zip.'
}
Assert-SigningCertificate (Get-AuthenticodeSignature -FilePath $signed) $signed
$directory = Join-Path $env:RUNNER_TEMP 'uninstaller-signing/signed'
New-Item -ItemType Directory -Force $directory | Out-Null
Copy-Item -LiteralPath $signed -Destination "$directory/orca-uninstaller.exe" -Force
