$ErrorActionPreference = 'Stop'
$root = Resolve-Path 'dist/win-unpacked'
$stage = New-Item -ItemType Directory -Force -Path 'signing-stage'
$list = New-Object System.Collections.Generic.List[string]
$skipped = New-Object System.Collections.Generic.List[string]

Get-ChildItem -Path $root -Recurse -File |
  Where-Object { $_.Extension -in '.exe', '.dll', '.node' } |
  ForEach-Object {
    $relative = [System.IO.Path]::GetRelativePath($root, $_.FullName)
    $signature = Get-AuthenticodeSignature -FilePath $_.FullName
    if ($signature.Status -eq 'Valid' -and $relative -ne 'resources\elevate.exe') {
      $skipped.Add("$relative  <already signed: $($signature.SignerCertificate.Subject)>")
      return
    }
    $destination = Join-Path $stage.FullName $relative
    New-Item -ItemType Directory -Force -Path (Split-Path $destination) | Out-Null
    Copy-Item -Path $_.FullName -Destination $destination -Force
    $list.Add($relative)
  }

if (-not ($list -contains 'Orca.exe')) {
  throw 'Orca.exe was not staged for signing; unpacked layout changed?'
}
if (-not ($list | Where-Object { $_ -like '*conpty_console_list.node' })) {
  throw 'node-pty conpty_console_list.node was not staged; this is the file from issue #7785.'
}

Set-Content -Path 'inner-signing-list.txt' -Value ($list -join "`n")
Write-Host "Staged $($list.Count) unsigned PE files for signing:"
$list | ForEach-Object { Write-Host "  $_" }
Write-Host "Skipped $($skipped.Count) already-signed files:"
$skipped | ForEach-Object { Write-Host "  $_" }
