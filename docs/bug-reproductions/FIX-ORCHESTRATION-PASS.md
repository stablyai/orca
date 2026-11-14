# Fix orchestration pass — 5 easiest has_repro bugs

**Date:** 2026-07-16  
**Agent:** GPT-5.6-Sol (worktree-isolated)  
**Worktrees:** Orca CLI (`orca worktree create`)

## Results

| Issue | PR | Worktree | Status |
|------:|----|----------|--------|
| [#8533](https://github.com/stablyai/orca/issues/8533) Cmd+Shift+E collision | [#9007](https://github.com/stablyai/orca/pull/9007) | `fix-8533-cmd-shift-e` | Open |
| [#8584](https://github.com/stablyai/orca/issues/8584) Mod+0 collision | [#9003](https://github.com/stablyai/orca/pull/9003) | `fix-8584-mod-0` | Open |
| [#8378](https://github.com/stablyai/orca/issues/8378) Codex reset time | [#9004](https://github.com/stablyai/orca/pull/9004) | `fix-8378-codex-reset-time` | Open |
| [#8844](https://github.com/stablyai/orca/issues/8844) file open missing path | [#9006](https://github.com/stablyai/orca/pull/9006) | `fix-8844-file-open-exists` | Open |
| [#8535](https://github.com/stablyai/orca/issues/8535) serve port pin | [#9005](https://github.com/stablyai/orca/pull/9005) | `fix-8535-serve-port-pin` | Open |

## Fix summary

1. **#8533** — Emulator default `Mod+Shift+E` → `Mod+Alt+Shift+E`; Explorer keeps `Mod+Shift+E`.
2. **#8584** — Focus worktree list `Mod+0` → `Mod+Shift+0`; zoom stays `Mod+0`.
3. **#8378** — Status bar chip uses remaining time when `resetsAt` present (matches popup).
4. **#8844** — `openMobileFile` stats path before open; missing → error, no ghost tab.
5. **#8535** — Explicit CLI `--port` binds pin first; default desktop keeps fallback-first (STA-1511).

## PR template requirement

Each PR includes Description, Evidence, ELI5, User-regression-tradeoffs.
