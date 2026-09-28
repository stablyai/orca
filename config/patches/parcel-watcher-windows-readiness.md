# Windows watcher build inputs

Windows relays and headless Orca ship a patched Parcel watcher. The patch waits for native registration before acknowledging a subscription and retains cancelled I/O requests until their completion callbacks finish. The native module still runs in the isolated watcher process.

Every desktop build includes relays for both Windows architectures, including desktop builds made on macOS and Linux. Install the normal project dependencies, then obtain both watcher artifacts before building relays or desktop packages.

## Download qualified artifacts

Use a successful **Bun profile persistence** or **PR Checks** run for the source you are building:

```sh
gh run download RUN_ID --name windows-watcher-X64 --dir .build/windows-watcher
gh run download RUN_ID --name windows-watcher-ARM64 --dir .build/windows-watcher
```

The result must contain `x64/` and `arm64/`, each with `watcher.node`, `LICENSE`, and `manifest.json`. Builds reject a mismatched source patch, package version, binary hash, architecture, or sanitizer artifact. Keep these downloaded files out of git.

## Build on Windows

With Node, Visual Studio C++ Build Tools, and the corresponding x64/ARM64 toolsets installed:

```sh
node config/scripts/build-windows-watcher-addon.mjs --arch=x64
node config/scripts/build-windows-watcher-addon.mjs --arch=arm64
```

The builder copies source and headers into a temporary directory, applies the checked-in patch, and compiles without modifying installed dependencies. Execution hosts do not need Node or a compiler.

CI's shared Windows watcher workflow runs the native smoke under Node and pinned Bun on each architecture, plus the x64 AddressSanitizer cancellation test. It publishes and caches the shipping binaries only after those checks pass. Sanitizer outputs use a separate directory and cannot be packaged. Other build jobs download these artifacts from the same workflow run.
