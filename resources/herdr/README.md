# Managed Herdr sidecar staging

Release automation must stage one verified Herdr distribution in the matching
`<platform>-<arch>` directory before invoking electron-builder. Each staged
directory contains the `herdr` executable (`herdr.exe` on Windows), Herdr's
`LICENSE`, and a `manifest.json` recording the upstream version, source commit,
protocol version, download URL, and SHA-256 checksum.

Supported directory names are `darwin-x64`, `darwin-arm64`, `linux-x64`,
`linux-arm64`, `win32-x64`, and `win32-arm64`. Built binaries and generated
manifests are release inputs and must not be committed.
