# Windows-only bugs (deferred)

These open issues are labeled `os:Windows` and/or are Windows/WSL-specific. They are **not** reproduced in this macOS orchestration pass. Track and reproduce on a Windows machine (or CI Windows runner) separately.

| Issue | Title | Notes |
|------:|-------|-------|
| 8813 | Visual indicators for statuses within the project don't appear | Yellow checkmark while working; CPU/memory; see `8813.md` |
| 8956 | Fail to list remote dirs | Remote FS listing on Windows |
| 8834 | In-app terminal cannot open Cursor CLI (system terminal can) | PATH / shell spawn |
| 8795 | Claude account switching does not work in Remote SSH projects | Windows host reported |
| 8793 | Windows Cursor agent (.cmd) cannot launch with prompt in argv — asks to Remove {prompt} | cmd quoting |
| 8787 | Windows wait-for-setup startup policy never starts the agent — doubled quotes in cmd wrapper | `ORCA_SETUP_MARKER` |
| 8763 | Orca has stopped recognizing Codex agents | Windows agent detection |
| 8754 | Orca don't render flutter command in Codex session without refreshing the tab | P1 render |
| 8751 | bug on windows upon returning session | P0 session restore |
| 8734 | Ctrl+Alt chords are swallowed by terminal input on Windows | P0 keybindings |
| 8645 | Hooks fail after updating Codex to v0.144.3 | Windows hooks |
| 8629 | Windows hook lifecycle test can overwrite live Codex runtime hooks | Test safety |
| 8627 | File sidebar is outdated on an old Orca version | pending-user-response |
| 8563 | Mouse wheel sends arrow keys to a normal-buffer CLI without mouse reporting | Wheel→keys |
| 8537 | Windows onboarding saves WSL as the default shell, but Settings shows PowerShell | Onboarding |
| 8475 | Chinese text sometimes garbled in Codex on Windows (WSL) | Encoding / WSL |
| 8302 | Windows agent list missing DeepSeek, icon mismatches, MiniMax quota | Agent list |
| 8291 | Terminal drag is completely broken | DnD |
| 8290 | Orca Windows renderer bug | Renderer |
| 8289 | Previous workspace surface remains visible after split collapse and worktree switch | Compositor |
| 8275 | Terminal daemon dies after batch worktree removal | Daemon |
| 8272 | Remote Windows host can disappear while smart sort refreshes it | Remote host |
| 8269 | Codex hook trust is lost between launches in WSL runtime | WSL hooks |
| 8258 | Cursor Agent CLI is not detected in the sidebar on Windows | Detection |
| 7725 | marketplace upgrade staging directories not cleaned up (multi-GB) | Disk growth |
| 7703 | Orca periodically causes system-wide keyboard focus loss | Focus steal |
| 7693 | The status of Kiro CLIs has not yet been determined | Status |
| 7563 | WSL GUI agent detection misses regular Claude while Claude CLI works | WSL detect |
| 7555 | codex-windows-sandbox-setup.exe module not found | Sandbox setup |
| 7372 | Switching b/w projects - terminal in focus is lost | Focus |
| 7175 | 'Not responding' and crash when running more than 3 sessions (32GB) | Perf/crash |
| 6896 | Worktree "Local setup command" built as cmd.exe under Git Bash | Setup shell |
| 6874 | Windows AppHangB1 when opening/activating terminal session | P0 hang |
| 6694 | Git Bash + Cursor agent: prompt mangled + hooks block | Dual bug |
| 6546 | Amp history not showing in right-side history panel on Windows 11 | History |
| 6487 | Application blocked by Windows Smart App Control (SAC) | Signing |
| 5345 | Scrolling causes duplicated/garbled text and panel overlap (Windows + WSL) | Render |
| 8366 | Sometimes Grok CLI is not detected in Orca but works in system terminal | Title says windows |
| 7351 | bundled CLI wrapper (orca.cmd) looks for Orca.exe in wrong directory | Labeled os:macos incorrectly? Verify on Windows |

## How to pick these up later

1. Use a Windows 11 host with a fresh Orca install (or the same version reported in the issue).
2. Prefer **production** `orca` from the installed app, not a stale dev CLI shim.
3. For each issue: capture screenshots, CLI JSON (`--json`), Event Viewer AppHang entries, and a short script under `docs/bug-reproductions/scripts/` when the bug is pure logic (quoting, PATH, force flags).
4. Never execute untrusted user-uploaded binaries from issues (especially `.exe` / `.cmd` / `.ps1` attachments). Recreate fixtures yourself.

## WSL-adjacent (may need Windows host even if not pure Win32)

| Issue | Title |
|------:|-------|
| 8470 | DaemonProtocolError when waking a slept WSL workspace |
| 8941 | WSL resource usage spikes (not always labeled bug) |
