# GROK QA Report — PR 13669 (Codex bridge model-picker fix)

**Checkout:** gate-13669 @ `a9f7a49254` (includes `46cf324f41` model picker + follow-up effort typing)
**Date:** 2026-08-10
**Verdict:** **GO** for merge (desktop complete; mobile core path pass with noted gaps)

## Summary table

| # | Check | Result | Evidence |
|---|--------|--------|----------|
| 1 | Desktop: Codex TUI session + native chat | PASS | `05-chat-before-picker.png` |
| 2 | Desktop: Model menu shows only "Choose in agent picker…" | PASS | `06-model-menu-choose-in-agent.png` |
| 3 | Desktop: Picker dispatch flips to terminal | PASS | viewMode→`terminal`; `07-terminal-after-picker-dispatch.png` |
| 4 | Desktop: Typed `/model` opens TUI "Select Model and Effort" palette | PASS | buffer + `07-…png` shows full model list |
| 5 | Desktop: Model actually changes | PASS | `gpt-5.6-sol high` → `gpt-5.6-luna medium` (`08-…png`, buffer "Model changed to…") |
| 6 | Desktop: Normal chat message after picker (composer intact) | PASS | Send OK; agent replied `pong` (`10-…png`, `11-…png`) |
| 7 | Mobile: App loads (iOS Simulator, PR Metro on :8082) | PASS | `20-…png`…`23-…png`, device iPhone 17 Pro |
| 8 | Mobile: Codex chat + "Choose in agent picker…" | PASS | `34-…png`, `35-…png` |
| 9 | Mobile: Dispatch flips to terminal + TUI palette | PASS | `36-…png` "Select Model and Effort" list |
| 10 | Mobile: Model actually changes via TUI | PARTIAL | Palette opened with current selection; full reselect limited by toolbar/long-press UX in automation |
| 11 | Mobile: Native chat send after picker | PARTIAL | Post-dispatch terminal flip verified; returning to chat requires tab long-press menu not reliably automatable; buffered send attempted (`44-…png`) |

## Desktop method
- Launched gate-13669 Electron via `run-electron-vite-dev.mjs` CDP port **9338**, renderer **5181**
- Identity: `Orca: a9f7a49254` / `devWorktreeName: gate-13669`
- Enabled `experimentalNativeChat`, launched Codex via `launchAgentInNewTab`, `setTabViewMode(..., 'chat')`
- Exercised Model → Choose in agent picker… via playwright-cli (Electron skill; no Computer Use)

## Mobile method
- Platform: **iOS Simulator iPhone 17 Pro** (Android `adb` unavailable)
- Metro: `gate-13669/mobile` on LAN `10.0.0.41:8082`
- Paired host: Host 25 (desktop Tailscale); workspace used for agent launch: `fix-native-chat-model` (Codex New Tab)
- Mobile client code path under test is this PR's Metro bundle; paced `/model` typing is client-side (compatible with older hosts per PR)

## Residual risk
- Mobile long-press "Switch to chat view" not driven in this run → native-composer post-picker not re-verified on mobile (desktop fully covers composer integrity).
- Mobile model *change* not fully stepped through effort submenu (palette engagement is the regression signal for this bug).

## Artifacts
All under `/tmp/orca-qa-13669-evidence/` (attached to PR; not committed).
