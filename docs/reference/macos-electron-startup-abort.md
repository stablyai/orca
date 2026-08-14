# macOS Electron startup abort (`_RegisterApplication`)

Two native Electron aborts have shown up in Orca on macOS. They look similar in
Console.app (the process just dies) and they are easy to confuse. They are not
the same bug.

## 1. Launch Services registration abort (this document)

**Symptom.** A brand-new `Orca` (or stock `Electron`) process lives ~100–200 ms
and dies with `SIGABRT` / `abort()` before any Orca JavaScript runs.

**Stack.**

```text
abort
___RegisterApplication_block_invoke
_RegisterApplication
GetCurrentProcess
-[NSApplication init]
+[NSApplication sharedApplication]
ElectronMain
```

**Cause.** `ElectronMain` always creates `NSApplication`. AppKit then asks
Launch Services for an application identity. If `launchservicesd` is
unreachable — a seatbelt/sandbox that denies `com.apple.lsd*` /
`com.apple.coreservices.launchservicesd`, a restricted agent environment, SSH
without a GUI login, CI — HIServices calls `abort()`. The single-instance lock
in our JS never runs.

This is an Electron-framework crash, not an Orca logic crash. Stock Electron
43.1.0 dies the same way:

```bash
# Repro (macOS). GUI launch aborts; ELECTRON_RUN_AS_NODE=1 does not.
cat > /tmp/deny-ls.sb << 'EOF'
(version 1)
(deny default)
(allow file-read*)
(allow file-write* (subpath "/tmp") (subpath "/private/tmp") (subpath "/var/folders"))
(allow process-exec)
(allow process-fork)
(allow sysctl-read)
(allow mach-lookup)
(deny mach-lookup (global-name "com.apple.lsd.modify"))
(deny mach-lookup (global-name "com.apple.lsd.mapdb"))
(deny mach-lookup (global-name "com.apple.launchservicesd"))
(deny mach-lookup (global-name "com.apple.coreservices.launchservicesd"))
EOF

sandbox-exec -f /tmp/deny-ls.sb \
  node_modules/electron/dist/Electron.app/Contents/MacOS/Electron
# exit 134 == SIGABRT

sandbox-exec -f /tmp/deny-ls.sb \
  env ELECTRON_RUN_AS_NODE=1 \
  node_modules/electron/dist/Electron.app/Contents/MacOS/Electron -e 'console.log("ok")'
# prints ok, exit 0
```

`open -a Orca` from the same sandbox fails with `_LSOpenURLsWithCompletionHandler
error -54` instead of aborting — still no GUI, but no crash loop. It is not a
sandbox workaround.

**What Orca does.**

- `orca open` reopens the packaged `Orca.app` via Launch Services (`open`), and
  does not exec `Contents/MacOS/Orca` when that path is the packaged binary.
- `orca serve` (without `--serve-recipe-json`) takes an exclusive
  `orca-serve.lock` in the `userData` profile, then refuses to spawn if a
  runtime is already live (exit code `3`, same contract as the single-instance
  lock). The lock is what stops two overlapping CLIs from both exec'ing
  Electron before JS can take the single-instance lock.
- `orca serve --serve-recipe-json` still detaches an ephemeral pairing helper
  and skips that already-running check.
- If a spawn still SIGABRTs, the CLI names this abort and points at
  `~/Library/Logs/DiagnosticReports/Orca-*.ips`.

**What to do as a user.**

1. If the desktop app is already up, use `orca status` / the regular `orca`
   commands. Do not keep retrying `orca serve` from an agent sandbox.
2. Do not exec `/Applications/Orca.app/Contents/MacOS/Orca` from a sandbox.
   Leave the sandbox and start the app from a normal macOS desktop login.
   `open -a Orca` and Finder are not sandbox workarounds (`open` fails with
   error `-54` there).
3. Confirm the crashing frame is `_RegisterApplication`, not `node::Utf8Value`.

Related: stablyai/orca#9282 (environment-induced), #10461 / #10464 (CLI
diagnostic), #12212 (Linux duplicate-serve crash loop — same class, later in
startup).

## 2. UTF-8 encode abort (different bug)

**Symptom.** The _already running_ app dies a few seconds after launch with
`SIGTRAP`, not `SIGABRT`.

**Stack.** `Assertion failed: (length + 1) <= (capacity())` in
`node::MaybeStackBuffer` / `node::Utf8Value`, typically from
`fs.writeFileSync` of a large JSON string that contains non-ASCII characters.

**Cause.** Electron 42.3.1 and 42.3.2 shipped an LLVM codegen bug that
miscomputed UTF-8 size. Reported as [electron/electron#51871](https://github.com/electron/electron/issues/51871),
fixed in 42.3.3 ([electron/electron#51849](https://github.com/electron/electron/pull/51849)).
Orca also stopped writing `orca-stats.json` in one shot (stablyai/orca#4571).

If you see `Utf8Value` / `writeFileSync` / `SIGTRAP`, that is this class, not
`_RegisterApplication`.
