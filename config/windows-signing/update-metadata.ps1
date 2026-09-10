$ErrorActionPreference = 'Stop'
node config/scripts/generate-windows-blockmap.mjs 'dist/orca-windows-setup.exe' 'dist/orca-windows-setup.exe.blockmap'
if ($LASTEXITCODE -ne 0) { throw "blockmap generation failed with exit code $LASTEXITCODE" }

$installer = Get-Item 'dist/orca-windows-setup.exe'
$blockmap = Get-Item 'dist/orca-windows-setup.exe.blockmap'
$stream = [System.IO.File]::OpenRead($installer.FullName)
try {
  $sha512 = [System.Security.Cryptography.SHA512]::Create()
  $hash = [Convert]::ToBase64String($sha512.ComputeHash($stream))
} finally {
  if ($null -ne $sha512) {
    $sha512.Dispose()
  }
  $stream.Dispose()
}

$latestYml = Get-Content -Path 'dist/latest.yml' -Raw
$latestYml = [regex]::Replace($latestYml, '(?m)^(\s*)sha512: .+$', {
  param($match)
  "$($match.Groups[1].Value)sha512: $hash"
})
$latestYml = $latestYml -replace '(?m)^    size: \d+$', "    size: $($installer.Length)"
$latestYml = $latestYml -replace '(?m)^    blockMapSize: \d+$', "    blockMapSize: $($blockmap.Length)"
Set-Content -Path 'dist/latest.yml' -Value $latestYml -NoNewline

Get-Item 'dist/orca-windows-setup.exe', 'dist/orca-windows-setup.exe.blockmap', 'dist/latest.yml'
