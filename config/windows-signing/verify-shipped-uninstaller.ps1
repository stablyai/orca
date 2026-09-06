$ErrorActionPreference = 'Stop'
& "$PSScriptRoot/verify-uninstaller.ps1"
. "$PSScriptRoot/signature-policy.ps1"
$signed = Join-Path $env:RUNNER_TEMP 'uninstaller-signing/signed/orca-uninstaller.exe'
$expectedDigest = (Get-FileHash -LiteralPath $signed -Algorithm SHA256).Hash.ToLowerInvariant()
try {
  $installedUninstaller = $null
  $full7z = 'C:/Program Files/7-Zip/7z.exe'
  $extract = Join-Path $env:RUNNER_TEMP 'uninstaller-nsis-extract'
  if (Test-Path -LiteralPath $extract) { Remove-Item -LiteralPath $extract -Recurse -Force }
  if (Test-Path -LiteralPath $full7z) {
    & $full7z x -tnsis 'dist/orca-windows-setup.exe' "-o$extract" -y 2>&1 | Out-Null
    # NSIS extraction is trustworthy only when it reproduces the relayed bytes.
    $matches = @(Get-ChildItem $extract -Recurse -File -Filter 'Uninstall*.exe' -ErrorAction SilentlyContinue |
      Where-Object { (Get-FileHash -LiteralPath $_.FullName -Algorithm SHA256).Hash.ToLowerInvariant() -eq $expectedDigest })
    if ($matches.Count -eq 1) { $installedUninstaller = $matches[0] }
  }
  if ($null -eq $installedUninstaller) {
    $installRoot = Join-Path $env:RUNNER_TEMP 'uninstaller-rehearsal-install'
    if (Test-Path -LiteralPath $installRoot) { Remove-Item -LiteralPath $installRoot -Recurse -Force }
    $installerProcess = Start-Process -FilePath (Resolve-Path 'dist/orca-windows-setup.exe') -ArgumentList "/S /D=$installRoot" -PassThru
    try {
      if (-not $installerProcess.WaitForExit(300000)) { throw 'The silent install did not exit within 5 minutes.' }
      if ($installerProcess.ExitCode -ne 0) { throw "The silent install failed: $($installerProcess.ExitCode)" }
    } finally {
      if (-not $installerProcess.HasExited) { $installerProcess | Stop-Process -Force -ErrorAction SilentlyContinue }
      for ($attempt = 0; $attempt -lt 20; $attempt++) {
        $running = @(Get-Process -Name 'Orca' -ErrorAction SilentlyContinue)
        if ($running.Count -gt 0) {
          $running | Stop-Process -Force -ErrorAction SilentlyContinue
          break
        }
        Start-Sleep -Milliseconds 500
      }
      Get-Process -Name 'orca-terminal-daemon' -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
    }
    $matches = @(Get-ChildItem $installRoot -Recurse -File -Filter 'Uninstall*.exe' -ErrorAction SilentlyContinue)
    if ($matches.Count -ne 1) { throw 'The silent install must produce exactly one uninstaller.' }
    $installedUninstaller = $matches[0]
  }
  $actual = (Get-FileHash -LiteralPath $installedUninstaller.FullName -Algorithm SHA256).Hash.ToLowerInvariant()
  if ($actual -cne $expectedDigest) { throw 'The shipped uninstaller does not match the signed bytes.' }
  Assert-SigningCertificate (Get-AuthenticodeSignature -FilePath $installedUninstaller.FullName) 'shipped: Uninstall Orca.exe'
  'VERIFIED shipped Uninstall Orca.exe: signature and digest match' | Add-Content 'uninstaller-signing-evidence.txt'
} catch {
  "VERDICT: FAILED — $_" | Add-Content 'uninstaller-signing-evidence.txt'
  throw
}
