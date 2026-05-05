---
name: mobile-fit-debug
description: Debug mobile terminal display-mode toggle and PTY resize issues. Use when investigating why a terminal restores to the wrong width after toggling between phone and desktop mode on mobile, or when PTY sizes are corrupted across tab switches.
---

# Mobile Fit Debug

Use this skill when debugging mobile terminal display-mode toggle issues — wrong restore width, corrupted previousCols, stale PTY sizes, or collateral safeFit cascades.

## Architecture Overview

The mobile display-mode toggle involves **3 processes** communicating asynchronously:

```
Mobile App (React Native)        Server (Electron main)         Desktop Renderer (Electron renderer)
─────────────────────────        ──────────────────────         ────────────────────────────────────
terminal.setDisplayMode ──RPC──► applyMobileDisplayMode
                                  ├─ resize PTY (authoritative)
                                  ├─ suppressResizesForMs(500)
                                  ├─ terminalFitOverrideChanged ──IPC──► setOverrideTick (React re-render)
                                  │                                       ├─ safeFit on ALL panes
                                  │                                       └─ pty:resize IPC ──────► SUPPRESSED
                                  └─ notifyTerminalResize ──stream──► mobile client updates
```

## Key Files

| File | Role |
|------|------|
| `src/main/runtime/orca-runtime.ts` | Server-side state: `mobileSubscribers`, `mobileDisplayModes`, `lastRendererSizes`, suppress window. Core handlers: `handleMobileSubscribe`, `handleMobileUnsubscribe`, `applyMobileDisplayMode`, `onExternalPtyResize` |
| `src/main/ipc/pty.ts` | `pty:resize` IPC handler. Checks `isResizeSuppressed()` before processing. Calls `onExternalPtyResize` to update server state |
| `src/main/runtime/rpc/methods/terminal.ts` | RPC methods: `terminal.subscribe` (mobile subscription lifecycle), `terminal.setDisplayMode`, `terminal.getDisplayMode` |
| `src/renderer/src/lib/pane-manager/mobile-fit-overrides.ts` | Desktop renderer's override cache. `setFitOverride('desktop-fit')` clears the override. `notifyChange` fires `onOverrideChange` listeners |
| `src/renderer/src/lib/pane-manager/pane-tree-ops.ts` | `safeFit()` — measures pane DOM and resizes xterm. When a mobile-fit override exists, uses override dims instead of measuring |
| `src/renderer/src/components/terminal-pane/TerminalPane.tsx` | `onOverrideChange` handler triggers `setOverrideTick` re-render cascade. This is what causes safeFit to run on ALL panes |
| `mobile/app/h/[hostId]/session/[worktreeId].tsx` | Mobile session screen — tab switching, `toggleDisplayMode`, terminal subscription management |
| `src/main/runtime/mobile-subscribe-integration.test.ts` | Integration tests for the full subscribe/unsubscribe/toggle lifecycle |

## Adding Debug Logging

Production code has no debug logging. To investigate issues, temporarily add file-based logging to the key files. Here's a pattern that works well:

### 1. Add mfLog helper to each file you want to instrument

```typescript
// In orca-runtime.ts (no prefix):
import { appendFileSync } from 'fs'
function mfLog(msg: string): void {
  try { appendFileSync('/tmp/mobile-fit-debug.log', `[${new Date().toISOString()}] ${msg}\n`) } catch {}
}

// In pty.ts (prefix [pty-ipc]):
function mfLog(msg: string): void {
  try { appendFileSync('/tmp/mobile-fit-debug.log', `[${new Date().toISOString()}] [pty-ipc] ${msg}\n`) } catch {}
}

// In terminal.ts RPC methods (prefix [rpc]):
function mfLog(msg: string): void {
  try { appendFileSync('/tmp/mobile-fit-debug.log', `[${new Date().toISOString()}] [rpc] ${msg}\n`) } catch {}
}
```

### 2. Useful log points

**orca-runtime.ts — `handleMobileSubscribe`:**
```typescript
mfLog(`handleMobileSubscribe ptyId=${ptyId} mode=${mode} viewport=${viewport?.cols}x${viewport?.rows}`)
mfLog(`  existing.prev=${existing?.previousCols}x${existing?.previousRows} currentSize=${currentSize?.cols}x${currentSize?.rows} rendererSize=${rendererSize?.cols}x${rendererSize?.rows}`)
mfLog(`  → previousCols=${previousCols}`)
```

**orca-runtime.ts — `applyMobileDisplayMode`:**
```typescript
mfLog(`applyMobileDisplayMode ptyId=${ptyId} mode=${mode} sub.prev=${subscriber?.previousCols}x${subscriber?.previousRows}`)
mfLog(`  DESKTOP RESTORE: previousCols=${previousCols}`)
```

**orca-runtime.ts — `onExternalPtyResize`:**
```typescript
mfLog(`onExternalPtyResize ptyId=${ptyId} cols=${cols} rows=${rows}`)
```

**pty.ts — `pty:resize` handler:**
```typescript
if (runtime?.isResizeSuppressed()) {
  mfLog(`pty:resize SUPPRESSED id=${args.id} cols=${args.cols} rows=${args.rows}`)
  return
}
mfLog(`pty:resize id=${args.id} cols=${args.cols} rows=${args.rows}`)
```

**terminal.ts — `terminal.subscribe`:**
```typescript
mfLog(`\n========== MOBILE SUBSCRIBE ==========`)
mfLog(`terminal.subscribe handle=${params.terminal} ptyId=${leaf?.ptyId} client=${params.client?.type}`)
```

### 3. Reading the log

```bash
> /tmp/mobile-fit-debug.log   # clear
# ... reproduce issue on mobile ...
cat /tmp/mobile-fit-debug.log  # read
```

### 4. Remember to remove logging before committing

Remove all `mfLog` functions, calls, and `appendFileSync` imports.

## What to Look For in Logs

**Wrong previousCols captured:**
```
handleMobileSubscribe ptyId=...@@abc123 ...
  existing.prev=null currentSize=105x72 rendererSize=214x72    <-- rendererSize is WRONG
  → previousCols=214                                            <-- captured wrong value
```
This means `lastRendererSizes` was polluted by a collateral safeFit cascade.

**Suppress window too short:**
```
[pty-ipc] pty:resize id=...@@abc123 cols=105 rows=72   <-- NOT suppressed, arrived after window
```
If you see unsuppressed `pty:resize` events for terminals that weren't the one being toggled, the 500ms suppress window may be too short. Check the timestamp gap between `applyMobileDisplayMode` and the stale resize.

**Suppress working correctly:**
```
[pty-ipc] pty:resize SUPPRESSED id=...@@abc123 cols=214 rows=72
```

**Collateral cascade pattern** (the root cause of most bugs):
```
applyMobileDisplayMode ptyId=...@@split mode=desktop
  DESKTOP RESTORE: previousCols=105
[pty-ipc] pty:resize SUPPRESSED id=...@@split cols=105    <-- redundant, suppressed OK
[pty-ipc] pty:resize SUPPRESSED id=...@@other cols=214    <-- collateral, suppressed OK
```
If the collateral line says `pty:resize id=` instead of `SUPPRESSED`, the cascade leaked through.

## Known Gotchas

### 1. The Collateral safeFit Cascade
When `terminalFitOverrideChanged` fires for ONE pane, the desktop renderer's `setOverrideTick` React state change triggers a re-render that runs `safeFit` on ALL panes across ALL tabs. Background-tab panes get measured at wrong widths because they may not be visible or may be in different split configurations than the active tab.

### 2. Cascade Timing is ~360ms
The full cascade path: server sends IPC -> desktop renderer receives -> React re-render -> requestAnimationFrame -> DOM measurement -> `pty:resize` IPC back to server. This takes ~360ms, which is why the suppress window must be >360ms (currently 500ms).

### 3. lastRendererSizes Persistence
`lastRendererSizes` stores every `pty:resize` from the desktop renderer. Stale values persist across mobile subscribe/unsubscribe cycles. The `lastRendererSizes.delete(ptyId)` in desktop restore is critical — without it, a stale 214 from a previous cascade gets used as `previousCols` on the next subscribe.

### 4. Daemon Doesn't Hot-Reload
The daemon process (`out/main/daemon-entry.js`) loads compiled code once at startup. Changes to `orca-runtime.ts` or `pty.ts` require:
1. `npx electron-vite build --outDir out` (or wait for watcher)
2. **Restart the dev server** (`pnpm dev`) — the daemon subprocess won't pick up new builds

Verify your code is live: `grep "your_unique_string" out/main/index.js`

### 5. previousCols Priority Chain
```typescript
previousCols = existing?.previousCols ?? rendererSize?.cols ?? currentSize?.cols
```
- `existing?.previousCols` — re-subscribe case (tab switch back), most trusted
- `rendererSize?.cols` — from `lastRendererSizes`, the desktop renderer's last `pty:resize`
- `currentSize?.cols` — from `getTerminalSize()`, the server-side PTY size

If `rendererSize` is polluted (e.g. 214 for a split pane), it takes priority over the correct `currentSize`. That's why clearing `lastRendererSizes` on restore is essential.

### 6. agent-device for Automated Testing
Use `/opt/homebrew/bin/agent-device` to automate mobile UI testing:
```bash
agent-device snapshot                    # accessibility tree
agent-device click @e45                  # click element by ref
agent-device screenshot --out /tmp/s.png # capture screenshot
agent-device wait 2                      # wait 2 seconds
```
Typical test flow: click tab -> click "Switch to desktop mode" -> wait 3s -> click "Switch to phone mode" -> switch tabs -> repeat -> read `/tmp/mobile-fit-debug.log`.

## Running Tests

```bash
npx vitest run src/main/runtime/mobile-subscribe-integration.test.ts
```
