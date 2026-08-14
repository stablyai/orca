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
# Repro (macOS). Exit 134 == SIGABRT. ELECTRON_RUN_AS_NODE=1 does not abort.
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
```

`open -a Orca` from the same sandbox fails with `_LSOpenURLsWithCompletionHandler
error -54` instead of aborting — still no GUI, but no crash loop.

**What Orca does.**

- `orca open` reopens the packaged `Orca.app` via Launch Services (`open`), and
  does not exec `Contents/MacOS/Orca` when that path is the packaged binary.
- `orca serve` does not spawn a second GUI process when this `userData` profile
  is already running (exit code `3`, same contract as the single-instance lock).
  A second exec is what produced the crash loop: each child died in
  `_RegisterApplication` before JS could take the lock.
- If a spawn still SIGABRTs, the CLI names this abort and points at
  `~/Library/Logs/DiagnosticReports/Orca-*.ips`.

**What to do as a user.**

1. If the desktop app is already up, use `orca status` / the regular `orca`
   commands. Do not keep retrying `orca serve` from an agent sandbox.
2. Do not exec `/Applications/Orca.app/Contents/MacOS/Orca` from a sandbox.
   Use `open -a Orca` or start the app from Finder.
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
