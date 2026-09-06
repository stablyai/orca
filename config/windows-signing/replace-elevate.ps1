$ErrorActionPreference = 'Stop'
. "$PSScriptRoot/signature-policy.ps1"
$signed = 'dist/win-unpacked/resources/elevate.exe'
if (-not (Test-Path -LiteralPath $signed)) { throw 'Missing elevate.exe in the checkpoint.' }
Assert-SigningCertificate (Get-AuthenticodeSignature -FilePath $signed) $signed
node config/scripts/replace-cached-nsis-elevate.mjs $signed
if ($LASTEXITCODE -ne 0) { throw 'Could not replace the NSIS toolset elevate.exe used by the rebuild.' }
