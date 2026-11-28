# Bug reproduction index

Orchestration **2026-07-15** · worktree `cooked-PRs` · production Orca **1.4.143** (`/Applications/Orca.app`) · macOS.

## How to use this folder

| Path | Purpose |
|------|---------|
| `README.md` | This index |
| `WINDOWS-ONLY.md` | Windows/WSL bugs deferred (need a Windows host) |
| `<issue-number>.md` | Per-issue status, evidence, re-run steps |
| `scripts/` | Shell / node helpers |
| `evidence/` | Captured JSON, logs |

### Production CLI note

`/usr/local/bin/orca` may be a **stale dev shim** pointing at a deleted worktree. Prefer:

```bash
PROD="/Applications/Orca.app/Contents/Resources/bin/orca"
"$PROD" status --json
```

### Security

Do **not** run issue attachments (`.exe`, `.cmd`, `.ps1`, mystery archives). Recreate fixtures yourself. No malicious payloads were found in the issues reviewed this pass.

### Status legend

- **REPRODUCED** — conclusive evidence + re-run steps/tests → GitHub label **`has_repro`**
- **NOT REPRODUCED** — attempted; current tree/app does not show the bug → GitHub label **`cannot_repro`**
- **PARTIAL** — root cause narrowed; full product path not live-proven (not labeled)
- **DEFERRED** — Windows / mobile / special host

Filter on GitHub:
- [`has_repro`](https://github.com/stablyai/orca/issues?q=is%3Aissue+label%3Ahas_repro)
- [`cannot_repro`](https://github.com/stablyai/orca/issues?q=is%3Aissue+label%3Acannot_repro)

---

## REPRODUCED (conclusive)

| Issue | Summary | Re-run |
|------:|---------|--------|
| [8844](./8844.md) | `orca file open` succeeds for missing files | default script is non-destructive; live open needs `ORCA_REPRO_8844_LIVE=1` (creates ghost tabs) |
| [8670](./8670.md) | Clean worktree + submodule needs `git worktree remove --force` | `bash docs/bug-reproductions/scripts/repro-8670-submodule-worktree-remove.sh` |
| [8454](./8454.md) | Bare `localhost:…` forced to `http://` | `pnpm exec vitest run src/shared/browser-url.test.ts` |
| [8533](./8533.md) / [8584](./8584.md) | Default shortcut collisions (`Mod+Shift+E`, `Mod+0`) | `pnpm exec vitest run --config config/vitest.config.ts src/shared/repro-8533-8584-shortcut-conflicts.test.ts` |
| [8595](./8595.md) | Bold Text color override is a no-op | `pnpm exec vitest run --config config/vitest.config.ts src/renderer/src/components/terminal-pane/repro-8595-bold-theme-noop.test.ts` |
| [8832](./8832.md) | Cmd-click URL glues next line text | `pnpm exec vitest run --config config/vitest.config.ts src/renderer/src/components/terminal-pane/repro-8832-url-next-line.test.ts` |
| [8940](./8940.md) | opencode labeled as Claude Code | `pnpm exec vitest run --config config/vitest.config.ts src/shared/repro-8940-opencode-as-claude.test.ts` |
| [8903](./8903.md) | Cmd-J focus lands on wrong (often hidden) surface | `pnpm exec vitest run --config config/vitest.config.ts src/renderer/src/components/cmd-j/repro-8903-cmdj-focus-fallback.test.ts` |
| [8962](./8962.md) | OMP terminals excluded from cold session restore | See `8962.md` (unit proofs on `RESUMABLE_TUI_AGENTS` / `extractAgentProviderSession`) |
| [8808](./8808.md) | Agent recognition fails on env-prefixed cmdline after restart | See `8808.md` (`recognizeAgentProcess` with `CLAUDE_CONFIG_DIR=… claude`); fix PR **#8942** |
| [8865](./8865.md) | Project Group hides members when Hide sleeping filters workspaces | See `8865.md`; fix PR **#8866** |
| [8532](./8532.md) | `Cmd+Shift+O` open markdown only works in floating terminal | See `8532.md`; fix PR **#8564** |
| [8577](./8577.md) | Settings search query leaks into Shortcuts row filter | See `8577.md`; fix PR **#8579** |
| [8784](./8784.md) | GHE PR avatars built from `github.com/{login}.png` | `pnpm exec vitest run --config config/vitest.config.ts src/renderer/src/components/github/repro-8784-ghe-avatar-fallback.test.ts`; fix PR **#8831** |
| [8935](./8935.md) | GHE PR work item diffs do not load (no Enterprise host) | `pnpm exec vitest run --config config/vitest.config.ts src/main/github/repro-8935-ghe-pr-diff-host.test.ts`; fix PR **#8932** |
| [8729](./8729.md) | .codex-pet ignores per-frame duration (uniform 8 fps) | `pnpm exec vitest run --config config/vitest.config.ts src/main/ipc/repro-8729-codex-pet-fps.test.ts` |
| [8695](./8695.md) | undici 7.28.0 paused-parser assert crashes main | unit + live: `bash docs/bug-reproductions/scripts/repro-8695-undici-paused-parser.sh` |
| [8720](./8720.md) | SSH relay npm 12 skips node-pty (no allowScripts) | `pnpm exec vitest run --config config/vitest.config.ts src/main/ssh/repro-8720-npm12-allow-scripts.test.ts` |
| [8535](./8535.md) | pinned `orca serve --port` overridden by mobile-ws fallback | `pnpm exec vitest run --config config/vitest.config.ts src/main/runtime/rpc/repro-8535-ws-fallback-port-order.test.ts` |
| [8739](./8739.md) | Linear filters only first selected team | `pnpm exec vitest run --config config/vitest.config.ts src/renderer/src/components/repro-8739-linear-filter-first-team.test.ts` |
| [8459](./8459.md) | Resource Manager kills live daemon as orphan | `pnpm exec vitest run --config config/vitest.config.ts src/renderer/src/components/status-bar/repro-8459-orphan-live-daemon.test.ts` |
| [8457](./8457.md) | headless serve hijacks GUI relaunch | `pnpm exec vitest run --config config/vitest.config.ts src/main/startup/repro-8457-serve-desktop-hijack.test.ts` |
| [8864](./8864.md) | Agent history lookup hangs forever | `pnpm exec vitest run --config config/vitest.config.ts src/main/ai-vault/repro-8864-history-lookup-no-timeout.test.ts` |
| [8482](./8482.md) | Window Blur sustained high GPU on macOS | `pnpm exec vitest run --config config/vitest.config.ts src/main/window/repro-8482-window-blur-gpu-cost.test.ts` |
| [8752](./8752.md) | Setup-script prompt stays after orca.yaml setup | `pnpm exec vitest run --config config/vitest.config.ts src/renderer/src/components/sidebar/repro-8752-setup-script-prompt-stale.test.ts` |
| [8726](./8726.md) | Tasks fork: auto PR→origin; count cache 120s | `pnpm exec vitest run --config config/vitest.config.ts src/main/github/repro-8726-fork-pr-auto-origin.test.ts` |
| [8934](./8934.md) | Jira ADF media images dropped in Tasks | `pnpm exec vitest run --config config/vitest.config.ts src/main/jira/repro-8934-adf-media-dropped.test.ts` |
| [8335](./8335.md) | Terminal stuck: mouse preserved on agent reattach | `pnpm exec vitest run --config config/vitest.config.ts src/renderer/src/components/terminal-pane/repro-8335-agent-editor-mouse-preserve.test.ts` |
| [8758](./8758.md) | node-pty unavailable on remote (same as #8720) | `pnpm exec vitest run --config config/vitest.config.ts src/main/ssh/repro-8758-node-pty-remote.test.ts` |
| [8541](./8541.md) | Remote multiplex timeout cascade | `pnpm exec vitest run --config config/vitest.config.ts src/shared/repro-8541-multiplex-timeout-cascade.test.ts` |
| [8622](./8622.md) | SSH keyboard-interactive MFA unsupported | `pnpm exec vitest run --config config/vitest.config.ts src/main/ssh/repro-8622-keyboard-interactive-missing.test.ts` |
| [8450](./8450.md) | SSH relay picks system Node without npm | `pnpm exec vitest run --config config/vitest.config.ts src/main/ssh/repro-8450-node-without-npm.test.ts` |
| [8742](./8742.md) | Antigravity sessions missing from AI Vault | `pnpm exec vitest run --config config/vitest.config.ts src/main/ai-vault/repro-8742-antigravity-not-scanned.test.ts` |
| [8299](./8299.md) | Shift+Space input-source switch also types space | `pnpm exec vitest run --config config/vitest.config.ts src/renderer/src/components/terminal-pane/repro-8299-shift-space-input-source.test.ts` |
| [8733](./8733.md) / [8399](./8399.md) | Option compose broken under kitty (vim/Pi) | `pnpm exec vitest run --config config/vitest.config.ts src/renderer/src/components/terminal-pane/repro-8733-8399-kitty-option-compose.test.ts` |
| [8986](./8986.md) | OMP tab status flash (working↔idle titles) | `pnpm exec vitest run --config config/vitest.config.ts src/shared/repro-8986-omp-status-flash.test.ts` |
| [8372](./8372.md) | Closed Resource Manager CLI count vs live daemon | `pnpm exec vitest run --config config/vitest.config.ts src/renderer/src/components/status-bar/repro-8372-closed-cli-count-stale.test.ts` |
| [8974](./8974.md) | Claude usage stuck “Refreshing sign-in” | `pnpm exec vitest run --config config/vitest.config.ts src/renderer/src/components/status-bar/repro-8974-refreshing-sign-in-stuck.test.ts` |

| [8797](./8797.md) | Background Opacity / Window Blur no-op on macOS | `pnpm exec vitest run --config config/vitest.config.ts src/main/window/repro-8797-blur-opacity-noop.test.ts` |
| [8378](./8378.md) | Codex session reset: popup vs status bar | `pnpm exec vitest run --config config/vitest.config.ts src/shared/repro-8378-codex-reset-time-mismatch.test.ts` |
| [8715](./8715.md) | OMP scroll resets on tab switch (alt buffer) | `pnpm exec vitest run --config config/vitest.config.ts src/renderer/src/lib/pane-manager/repro-8715-omp-alt-screen-scroll.test.ts` |
| [8881](./8881.md) | Sidebar duplicates worktrees after re-pair | `pnpm exec vitest run --config config/vitest.config.ts src/renderer/src/store/slices/repro-8881-runtime-repair-duplicates.test.ts` |
| [8878](./8878.md) | Remote client resumes live host agents | `pnpm exec vitest run --config config/vitest.config.ts src/renderer/src/lib/repro-8878-remote-resume-no-runtime-gate.test.ts`; fix PR **#8887** |
| [8593](./8593.md) | Lingering idle subagent sidebar rows | `pnpm exec vitest run --config config/vitest.config.ts src/renderer/src/components/sidebar/repro-8593-idle-subagent-rows.test.ts` |
| [8478](./8478.md) | OpenCode native title → wrong icon | `pnpm exec vitest run --config config/vitest.config.ts src/shared/repro-8478-opencode-native-title-icon.test.ts`; fix PR **#8590** |

### NOT REPRODUCED (Batch C)

| Issue | Summary | Re-run |
|------:|---------|--------|
| [8749](./8749.md) | Agent seatbelt blocks claude-hook.sh | live sandbox_check=0; `src/main/agent-hooks/repro-8749-hook-path-no-seatbelt.test.ts` |
| [8943](./8943.md) | Browser shows insecure | screenshot-only; `src/main/browser/repro-8943-browser-insecure-indicator.test.ts` |

### Batch re-run (unit tests that live under `src/`)

```bash
pnpm exec vitest run --config config/vitest.config.ts \
  src/shared/repro-8533-8584-shortcut-conflicts.test.ts \
  src/renderer/src/components/terminal-pane/repro-8595-bold-theme-noop.test.ts \
  src/renderer/src/components/terminal-pane/repro-8832-url-next-line.test.ts \
  src/shared/repro-8940-opencode-as-claude.test.ts \
  src/renderer/src/components/cmd-j/repro-8903-cmdj-focus-fallback.test.ts \
  src/shared/browser-url.test.ts \
  src/renderer/src/components/github/repro-8784-ghe-avatar-fallback.test.ts \
  src/main/github/repro-8935-ghe-pr-diff-host.test.ts \
  src/main/ipc/repro-8729-codex-pet-fps.test.ts \
  src/main/repro-8695-undici-paused-parser.test.ts \
  src/main/ssh/repro-8720-npm12-allow-scripts.test.ts \
  src/main/runtime/rpc/repro-8535-ws-fallback-port-order.test.ts \
  src/renderer/src/components/repro-8739-linear-filter-first-team.test.ts \
  src/renderer/src/components/status-bar/repro-8459-orphan-live-daemon.test.ts \
  src/main/startup/repro-8457-serve-desktop-hijack.test.ts \
  src/main/ai-vault/repro-8864-history-lookup-no-timeout.test.ts \
  src/main/window/repro-8482-window-blur-gpu-cost.test.ts \
  src/renderer/src/components/sidebar/repro-8752-setup-script-prompt-stale.test.ts \
  src/main/github/repro-8726-fork-pr-auto-origin.test.ts \
  src/main/jira/repro-8934-adf-media-dropped.test.ts \
  src/renderer/src/components/terminal-pane/repro-8335-agent-editor-mouse-preserve.test.ts \
  src/main/ssh/repro-8758-node-pty-remote.test.ts \
  src/shared/repro-8541-multiplex-timeout-cascade.test.ts \
  src/main/ssh/repro-8622-keyboard-interactive-missing.test.ts \
  src/main/ssh/repro-8450-node-without-npm.test.ts \
  src/main/ai-vault/repro-8742-antigravity-not-scanned.test.ts \
  src/renderer/src/components/terminal-pane/repro-8299-shift-space-input-source.test.ts \
  src/renderer/src/components/terminal-pane/repro-8733-8399-kitty-option-compose.test.ts \
  src/shared/repro-8986-omp-status-flash.test.ts \
  src/renderer/src/components/status-bar/repro-8372-closed-cli-count-stale.test.ts \
  src/renderer/src/components/status-bar/repro-8974-refreshing-sign-in-stuck.test.ts \
  src/renderer/src/store/slices/repro-8539-fetchAllWorktrees-reconnect.test.ts
```

```bash
# Git fixture (safe)
bash docs/bug-reproductions/scripts/repro-8670-submodule-worktree-remove.sh

# #8844 — evidence-only by default (does NOT open editor tabs)
bash docs/bug-reproductions/scripts/repro-8844-file-open-missing.sh
# Live missing-path open creates ghost ENOENT tabs — only if you really need it:
# ORCA_REPRO_8844_LIVE=1 bash docs/bug-reproductions/scripts/repro-8844-file-open-missing.sh

# #8695 — process crash expected (undici assert)
bash docs/bug-reproductions/scripts/repro-8695-undici-paused-parser.sh
```

---

## PARTIAL

| Issue | Summary | Notes |
|------:|---------|-------|
| [8970](./8970.md) | Closed agent session lingers in sidebar | Happy-path close clears status; residual races after #8825/#8851 not live-proven |
| [8539](./8539.md) | Renderer freeze 87s on reconnect many worktrees | Call sites + O(repos) work proven; live multi-host freeze not run |

---

## NOT REPRODUCED

| Issue | Summary | Notes |
|------:|---------|-------|
| [8838](./8838.md) | `<br>` in markdown table cells | Current `MarkdownPreview` pipeline emits real `<br/>` — `pnpm exec node docs/bug-reproductions/scripts/repro-8838-br-in-table.mjs` |
| [8440](./8440.md) | MCP OAuth not persisting in Orca terminals | Maintainer could not repro; no in-tree generic MCP OAuth store bug; needs agent/MCP credential path |
| [8749](./8749.md) | Agent seatbelt blocks claude-hook.sh | Live daemon PTY `sandbox_check=0`; no seatbelt in daemon spawn code |
| [8943](./8943.md) | Browser shows insecure | Screenshot-only; intentional popup “Not secure” for remote http |

---

## DEFERRED

| Bucket | Doc / notes |
|--------|-------------|
| **Windows / WSL** | [WINDOWS-ONLY.md](./WINDOWS-ONLY.md) — 30+ open bugs |
| **Linux/IBus/X11** | #8861 (CJK IME), #8860 (middle-click paste twice) |
| **GitHub Enterprise (live UI)** | Live GHE UI still needs a host; code-level repros done for #8935 / #8784 (fix PRs #8932 / #8831) |
| **Mobile / iOS / Android** | #8933, #8889, #8818, #8700, #8666, #8555, #8592, #8364, #8313, … |
| **Sandbox / live agent** | #8749 (claude-hook.sh EPERM) — needs Orca-hosted Claude session |
| **SSH / remote runtime** | #8878, #8871, #8696, … — need remote hosts (#8720/#8450/#8758/#8541/#8622 code-level done) |
| **Perf / scale** | #8814, #8882, #8652 — need multi-worktree load (#8539 PARTIAL call sites) |
| **Windows project status UI** | #8813 — see [WINDOWS-ONLY.md](./WINDOWS-ONLY.md) / `8813.md` |

---

## What we need from you (only blockers for next steps)

1. **Windows host or CI** — process [WINDOWS-ONLY.md](./WINDOWS-ONLY.md) (P0: #8751, #8734, #6874).
2. **GHE credentials / sandbox** — optional live UI for #8935/#8784 (code-level REPRODUCED; fix PRs #8932 / #8831).
3. **Mobile device or emulator pairing** — for freezes/rename/browser-tab bugs.
4. **Confirm live UI for #8970** — still seeing lingering closed sessions on 1.4.143 after #8825?
5. **Linux remote with npm 12** — optional live for #8720 (code-level REPRODUCED: missing `allowScripts`).

Everything else in the REPRODUCED table is re-runnable by another agent without extra access.
