$ErrorActionPreference = 'Stop'
pnpm exec electron-builder --config config/electron-builder.config.cjs --win --publish never --prepackaged "$env:GITHUB_WORKSPACE\dist\win-unpacked"
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
if (-not (Test-Path 'dist/orca-windows-setup.exe')) {
  throw 'electron-builder --prepackaged did not produce dist/orca-windows-setup.exe'
}
