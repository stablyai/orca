$ErrorActionPreference = 'Stop'
. "$PSScriptRoot/signature-policy.ps1"
$root = Resolve-Path 'dist/win-unpacked'
$failures = New-Object System.Collections.Generic.List[string]
foreach ($relative in Get-Content 'inner-signing-list.txt') {
  $signedPath = Join-Path (Resolve-Path 'signed-inner') $relative
  if (-not (Test-Path -LiteralPath $signedPath -PathType Leaf)) {
    $failures.Add("missing from signed artifact: $relative")
    continue
  }
  $signed = Get-Item -LiteralPath $signedPath
  $signature = Get-AuthenticodeSignature -FilePath $signed.FullName
  if ($null -eq $signature.SignerCertificate) {
    $failures.Add("returned without a signature: $relative")
    continue
  }
  Assert-SigningCertificate $signature $relative
  Copy-Item -LiteralPath $signed.FullName -Destination (Join-Path $root $relative) -Force
  Write-Host ("{0,-14} {1}  <{2}>" -f $signature.Status, $relative, $signature.SignerCertificate.Subject)
}
if ($failures.Count -gt 0) {
  $failures | ForEach-Object { Write-Host "::error::$_" }
  throw "Signed inner artifact did not round-trip cleanly ($($failures.Count) failures)."
}
