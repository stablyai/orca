$ErrorActionPreference = 'Stop'
. "$PSScriptRoot/signature-policy.ps1"
$report = [System.Collections.Generic.List[string]]::new()
try {
  $output = node config/scripts/resolve-7za-path.mjs
  if ($LASTEXITCODE -ne 0) { throw 'Cannot resolve the installer extractor.' }
  $extractor = ($output | Out-String).Trim()
  if (-not (Test-Path -LiteralPath $extractor -PathType Leaf)) { throw 'Invalid installer extractor.' }
  foreach ($directory in @('inner-evidence-extract', 'inner-evidence-payload')) {
    if (Test-Path -LiteralPath $directory) { Remove-Item -LiteralPath $directory -Recurse -Force }
  }
  & $extractor x 'dist/orca-windows-setup.exe' '-oinner-evidence-extract' -y | Out-Null
  if ($LASTEXITCODE -ne 0) { throw 'Cannot extract the signed installer payload.' }
  # NSIS carries the application as a second compressed archive.
  $packages = @(Get-ChildItem 'inner-evidence-extract' -Recurse -File | Where-Object { $_.Name -in @('app-64.7z', 'app-64.zip') })
  if ($packages.Count -ne 1) { throw 'Expected exactly one x64 application archive inside the installer.' }
  & $extractor x $packages[0].FullName '-oinner-evidence-payload' -y | Out-Null
  if ($LASTEXITCODE -ne 0) { throw 'Cannot extract the embedded application archive.' }
  $root = Resolve-Path 'inner-evidence-payload'
  $targets = @(Get-Content -LiteralPath 'inner-signing-list.txt')
  if ($targets.Count -eq 0 -or $targets -notcontains 'Orca.exe') { throw 'Missing inner signing inventory.' }
  if ($targets -notcontains 'resources\elevate.exe') { $targets += 'resources\elevate.exe' }
  $failures = [System.Collections.Generic.List[string]]::new()
  foreach ($relative in $targets) {
    try {
      $path = Join-Path $root $relative
      if (-not (Test-Path -LiteralPath $path -PathType Leaf)) { throw "Missing installer payload: $relative" }
      $signature = Get-AuthenticodeSignature -FilePath $path
      Assert-SigningCertificate $signature $relative
      $report.Add("VERIFIED $relative <$($signature.SignerCertificate.Subject)>")
    } catch {
      $failures.Add("$relative : $_")
      $report.Add("FAILED $relative : $_")
    }
  }
  if ($failures.Count -gt 0) { throw "Installer contains $($failures.Count) missing or incorrectly signed binaries." }
  $report.Add("VERDICT: PASSED — $($targets.Count) shipped inner binaries verified.")
} catch {
  $report.Add("VERDICT: FAILED — $_")
  throw
} finally {
  $report | Set-Content -LiteralPath 'inner-signing-evidence.txt'
  if ($env:GITHUB_STEP_SUMMARY) { $report[-1] >> $env:GITHUB_STEP_SUMMARY }
}
