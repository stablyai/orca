$ErrorActionPreference = 'Stop'
. "$PSScriptRoot/signature-policy.ps1"
$signed = 'dist/win-unpacked/resources/elevate.exe'
if (-not (Test-Path -LiteralPath $signed)) { throw 'Missing elevate.exe in the checkpoint.' }
Assert-SigningCertificate (Get-AuthenticodeSignature -FilePath $signed) $signed
$cached = @(Get-ChildItem "$env:LOCALAPPDATA/electron-builder/Cache/nsis" -Recurse -Filter elevate.exe)
if ($cached.Count -eq 0) { throw 'The restored NSIS cache has no elevate.exe to replace.' }
foreach ($file in $cached) { Copy-Item -LiteralPath $signed -Destination $file.FullName -Force }
