$ErrorActionPreference = 'Stop'
. "$PSScriptRoot/signature-policy.ps1"
Assert-SigningCertificate (Get-AuthenticodeSignature -FilePath dist/orca-windows-setup.exe) 'dist/orca-windows-setup.exe'
