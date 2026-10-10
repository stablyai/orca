$ErrorActionPreference = 'Stop'
if (-not $IsWindows) { throw 'WSL test provisioning requires a Windows runner' }

$rootfs = Join-Path $env:RUNNER_TEMP 'noble-rootfs.tar.gz'
Invoke-WebRequest 'https://releases.ubuntu.com/24.04.4/ubuntu-24.04.4-wsl-amd64.wsl' -OutFile $rootfs
if ((Get-FileHash $rootfs -Algorithm SHA256).Hash.ToLowerInvariant() -ne '9b2f7730dc68227dd04a9f3e5eab86ad85caf556b8606ad94f1f29ff5c4fd3f5') { throw 'Ubuntu rootfs checksum mismatch' }
$distroDir = Join-Path $env:RUNNER_TEMP 'orca-wsl-ubuntu'
wsl.exe --import Ubuntu $distroDir $rootfs --version 1
if ($LASTEXITCODE -ne 0) { throw "WSL import failed: $LASTEXITCODE" }
wsl.exe --distribution Ubuntu --user root --exec /usr/bin/true
if ($LASTEXITCODE -ne 0) { throw "WSL guest did not start: $LASTEXITCODE" }
wsl.exe --distribution Ubuntu --user root --exec /usr/bin/apt-get update
if ($LASTEXITCODE -ne 0) { throw "WSL apt update failed: $LASTEXITCODE" }
wsl.exe --distribution Ubuntu --user root --exec /usr/bin/apt-get install --yes git curl xz-utils
if ($LASTEXITCODE -ne 0) { throw "WSL git install failed: $LASTEXITCODE" }
$kernelMsi = Join-Path $env:RUNNER_TEMP 'wsl_update_x64.msi'
Invoke-WebRequest 'https://wslstorestorage.blob.core.windows.net/wslblob/wsl_update_x64.msi' -OutFile $kernelMsi
if ((Get-FileHash $kernelMsi -Algorithm SHA256).Hash.ToLowerInvariant() -ne '4d09c776c8d45f70a202281d18e19be1118f53159b0c217a5274a31ce18525fe') { throw 'WSL kernel installer checksum mismatch' }
$installer = Start-Process msiexec.exe -ArgumentList @('/i', $kernelMsi, '/quiet', '/norestart') -Wait -PassThru
if ($installer.ExitCode -ne 0) { throw "WSL kernel installation failed: $($installer.ExitCode)" }
wsl.exe --status
if ($LASTEXITCODE -ne 0) { throw "WSL status failed: $LASTEXITCODE" }
wsl.exe --distribution Ubuntu --user root --exec /usr/bin/curl --fail --silent --show-error --location https://nodejs.org/dist/v22.14.0/node-v22.14.0-linux-x64.tar.xz --output /tmp/orca-node.tar.xz
if ($LASTEXITCODE -ne 0) { throw 'Node download failed' }
$nodeHash = wsl.exe --distribution Ubuntu --user root --exec /usr/bin/sha256sum /tmp/orca-node.tar.xz
if ($LASTEXITCODE -ne 0 -or -not ($nodeHash -match '^69b09dba5c8dcb05c4e4273a4340db1005abeafe3927efda2bc5b249e80437ec')) { throw 'Node checksum mismatch' }
wsl.exe --distribution Ubuntu --user root --exec /usr/bin/tar -xJf /tmp/orca-node.tar.xz -C /usr/local --strip-components=1
if ($LASTEXITCODE -ne 0) { throw 'Node extraction failed' }
wsl.exe --distribution Ubuntu --user root --exec /usr/local/bin/node --version
if ($LASTEXITCODE -ne 0) { throw 'Node cannot execute in WSL' }
wsl.exe --list --verbose
if ($LASTEXITCODE -ne 0) { throw "WSL enumeration failed: $LASTEXITCODE" }
