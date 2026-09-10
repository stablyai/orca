$ErrorActionPreference = 'Stop'
. "$PSScriptRoot/signature-policy.ps1"
$signed = Join-Path $env:RUNNER_TEMP 'uninstaller-signing/signed/orca-uninstaller.exe'
$receipt = "$signed.embedded-sha256"
try {
  if (-not (Test-Path -LiteralPath $signed -PathType Leaf) -or -not (Test-Path -LiteralPath $receipt -PathType Leaf)) {
    throw 'The installer rebuild must embed the signed uninstaller and produce a receipt.'
  }
  Assert-SigningCertificate (Get-AuthenticodeSignature -FilePath $signed) $signed
  $actual = (Get-FileHash -LiteralPath $signed -Algorithm SHA256).Hash.ToLowerInvariant()
  if ((Get-Content -LiteralPath $receipt -Raw).Trim() -cne $actual) { throw 'Embedded uninstaller receipt does not match the signed bytes.' }
  "VERIFIED Uninstall Orca.exe: signed bytes handed to NSIS ($actual)" | Set-Content 'uninstaller-signing-evidence.txt'
} catch {
  "VERDICT: FAILED — $_" | Set-Content 'uninstaller-signing-evidence.txt'
  throw
}
