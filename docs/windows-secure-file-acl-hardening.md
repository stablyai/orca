# Windows Secure-File ACL Hardening

## Problem

Credential files Orca writes on Windows (runtime env auth store, device registry,
e2ee keypair) must end up readable only by the current user, SYSTEM, and
Administrators. On POSIX this is a one-line `chmodSync`, but `writeFileSync`'s
`mode` option is a no-op on Windows, so the NTFS ACL has to be rewritten by
shelling out to PowerShell (`Get-Acl` / `Set-Acl`). PowerShell cold-start is
~1–1.5 s.

`readEnvironmentStore` calls `hardenExistingSecureFile` on every read. The
env-store parent directory's mtime churns constantly (every secure write updates
it), so an mtime-keyed idempotency cache never matches and a blocking PowerShell
spawn fires on every call. After the remote-runtime tab-sync polling change, the
store is read ~2×/s, turning sporadic mtime misses into a continuous main-thread
storm (~1.8 powershell.exe spawns/sec) that saturates the Electron main thread
and times out `runtimeEnvironments:call`. See #4901 / #5006.

## Model

`src/shared/secure-file.ts` applies two different caching + execution strategies,
chosen by whether the target is a directory and whether it is on the write path:

- **Directories — async + path-cached for the process lifetime.**
  A directory's required ACL does not change when its mtime changes, so once a
  directory has been hardened in this process it is trusted for the rest of the
  process. Directory hardening uses fire-and-forget `execFile` so it never blocks
  the main thread. This is the change that kills the #4901 storm.
  - _Known limitation:_ a directory that is deleted and recreated mid-process is
    not re-hardened until the next restart. The `.orca` secure dirs are not
    deleted at runtime, so this is acceptable.

- **Credential files on the write path — synchronous, cache only on success.**
  Because `writeFileSync({ mode })` is a no-op on Windows, a freshly written file
  carries the parent directory's inherited (broader) ACL. `writeSecureFile` must
  therefore restrict the file's ACL **synchronously** (via `execFileSync`) on the
  temp file and on the renamed target before it returns — otherwise the function
  would return with the credential briefly readable under inherited ACLs during
  the ~1–1.5 s PowerShell cold-start window. The write path is infrequent, so the
  synchronous cost is acceptable. The path is cached as hardened **only on
  confirmed success**, so a failed apply is retried on the next write.

- **Existing files on the read path — async + metadata-cached.**
  `hardenExistingSecureFile` re-asserts the ACL on an already-existing file at
  most once per process (keyed on inode/size/timestamps so post-rename inode
  changes are detected). Async is safe here because it only re-asserts an ACL on a
  file that already exists; new files are hardened synchronously on the write path
  above. Because it fires at most once per file, it does not storm.

The net effect: the frequent read path never blocks the main thread, while the
infrequent write path closes the async window so credential files are never
published with a broader-than-intended ACL.

## Requirements

- Read-path directory and existing-file hardening must not spawn PowerShell more
  than once per path per process, regardless of mtime churn.
- `writeSecureFile` must apply the credential file's ACL synchronously before
  returning; the file ACL must not be left to a background process.
- A failed synchronous file-ACL apply must not crash the write and must not be
  cached as hardened (so it retries).
- No PowerShell is spawned on non-win32 platforms.

## Manual Windows end-to-end test plan

The automated e2e harness (`pnpm test:e2e`, Playwright `electron-headless`) runs
on `ubuntu-latest`, where `applySecurePathRestriction` short-circuits to
`chmodSync` and never reaches the PowerShell path. The ACL storm therefore cannot
be reproduced in the cross-platform e2e harness; verify it manually on Windows.

Pre-req: a Windows client paired to a remote `orca serve` runtime.

Watcher (PowerShell, run before launching Orca):

```powershell
while ($true) {
  $n = (Get-CimInstance Win32_Process -Filter "Name='powershell.exe'").Count
  "{0}  powershell.exe count = {1}" -f (Get-Date -Format HH:mm:ss), $n
  Start-Sleep -Milliseconds 500
}
```

Steps:

1. Launch the **stock v1.4.52/v1.4.53** build and open the remote workspace.
   - **Before fix:** the watcher oscillates ~1–2 powershell.exe processes/sec
     continuously through the load window; the app is unresponsive and the
     `[web-session-tabs-sync] … RemoteRuntimeClientError: Timed out` error
     appears in the console.
2. Launch the **fixed** build and open the same remote workspace.
   - **After fix:** the watcher stays at `0` (no continuous powershell churn); the
     env-store directory is hardened at most once; the app loads without the
     session-tabs timeout.
3. Write a credential (e.g. sign in / register a device so a secure file is
   written), then immediately inspect the file ACL:

   ```powershell
   icacls "$env:APPDATA\orca\orca-environments.json"
   ```

   - **Expected:** only the current user, `SYSTEM`, and `Administrators` have
     access the instant the write completes (no inherited entries), confirming the
     synchronous file-ACL apply closed the async window.
