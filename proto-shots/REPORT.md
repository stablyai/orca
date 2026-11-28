# App rail: show on hover (prototype, item 2230)

Branch `AmethystLiang/rail-autohide-proto` in worktree `/Users/jinjingliang/Documents/projects/orca/squid-2`. This is a try-out build, not a PR.

## Try it

A dev instance is running in the background on an isolated profile (`~/.orca-proto-profiles/rail-autohide`). It was started with background launch so it would not take over the screen, which means its window stays off screen. To get a window you can use, stop it and relaunch in the foreground:

```bash
cd /Users/jinjingliang/Documents/projects/orca/squid-2
kill -TERM "$(node -e 'console.log(require("./out/dev-instance.json").runnerPid)')"   # stops only this dev runner
ORCA_DEV_USER_DATA_PATH="$HOME/.orca-proto-profiles/rail-autohide" \
  node config/scripts/development/launch/run-electron-vite-dev.mjs -- --use-mock-keychain --password-store=basic
```

- The profile is new and isolated, so your real profile and workspaces are never touched. Add any folder to play with.
- `--use-mock-keychain --password-store=basic` is needed because a new dev profile otherwise stalls on a hidden Keychain prompt at startup.
- Run the runner script directly, not `pnpm dev --…`: electron-vite rejects unknown flags.

### Switch the style variant (prototype only)

In DevTools (View › Toggle Developer Tools), run one of these. It takes effect on the next reveal, with no reload:

```js
localStorage.setItem('orca.railAutohideVariant', 'float') // B, the default: rounded card
localStorage.setItem('orca.railAutohideVariant', 'dock') // A: full-height flush overlay
localStorage.setItem('orca.railAutohideVariant', 'sliver') // C: 3px sliver at the edge
```

To watch the first-launch intro again: `localStorage.setItem('orca.railAutohideReplayFirstRun','1')`, then reload (⌘R).

### Switch the mode

- Rail "…" menu (or right-click anywhere on the rail): **Show on hover** / **Always show**.
- Settings › Experimental › App rail › "Show the app rail".

## What works (checked in the dev build)

| Behavior                                                            | Result                                                                                          |
| ------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| Reveal: pointer rests in the 8px zone below the title bar for 100ms | opens; a 40ms pass-over does not; the title-bar strip does not                                  |
| Hide: 300ms after the pointer leaves the rail                       | closes                                                                                          |
| Mouse down in the zone (window-edge resize)                         | cancels the reveal                                                                              |
| Menu open, or a rail button with keyboard focus                     | stays open                                                                                      |
| Esc                                                                 | hides; focus goes back to where it was (e.g. the terminal)                                      |
| Right-click → menu → Esc                                            | menu closes, rail hides once the pointer is away (this was a bug found while capturing; fixed)  |
| Pointer leaves the window / window blur                             | hides                                                                                           |
| Dragging to the left edge                                           | reveals (dragover); drop/dragend away hides                                                     |
| Tab / `.focus()` into the rail                                      | reveals at once; arrow keys within the rail keep it open                                        |
| Always → hover with the pointer on the rail                         | content slides left (slot 40→0), rail stays until the pointer leaves, then slides out           |
| Hover → always                                                      | slot 0→40 (content slides right), card insets/radius/shadow animate into the docked rail        |
| First launch (setting never set)                                    | docked for 1s, undocks, slides away about 0.7s later with a short edge glow, then saves `hover` |
| Reduced motion                                                      | fade only (no translate)                                                                        |
| More menu when the rail folds (short windows)                       | the visibility rows are added there too (code path only, not captured)                          |

**No reflow on reveal:** a ResizeObserver on the terminal (`.xterm`), the content column, and the list counted **0** callbacks across a reveal and hide. Content x/width stayed at 280/1000 at 1280px. The PTY never resizes on reveal.

## Perf reasoning

- Hover mode adds one passive `pointermove` listener on `window`. Its common path is a single `clientX < 8` compare; layout (`getBoundingClientRect`) is read only inside the 8px zone. React state changes only on open/close transitions, and only the slot re-renders (the rail element is a stable child, so it bails out).
- The other listeners are event-driven and rare: pointerdown/up (capture, passive), keydown (capture, for Esc), focusin (capture, to remember where focus came from), blur, dragover/drop/dragend, and document `mouseleave`. Enter/leave and focus listeners sit on the panel. A MutationObserver watches only `aria-expanded` under the rail, so it fires only when a rail menu opens or closes.
- All of these are attached only in hover mode and removed when docked.
- The reveal is transform/opacity on an absolutely positioned panel, so it runs on the compositor with no layout of siblings. The only layout-changing animation is the slot width during a **mode switch** (40↔0px over 180ms). That resizes terminals the way a sidebar toggle does, but only when the setting changes.

## Deviations from the mockup

- The radio rows use the design-system `DropdownMenuRadioItem` with the check in the left indicator column. The mockup puts it on the right like the page checkboxes. No padding/gap overrides on the menu primitives.
- Right-click opens the same "…" menu, anchored to the "…" button rather than to the pointer.
- The setting lives under Settings › Experimental › App rail (where the rail toggle already is), not Settings › Appearance. There is no View › Show app rail menu item.
- Window blur does not hide the rail while one of its menus is open.
- The edge glow uses the gray `--ring` token. It is faint, especially on light theme; the mockup used a blue tint that has no matching token.
- In variant A, the overlay covers the left 40px of the title bar while revealed. That strip is set as a window-drag region.
- Only `en` strings were added (other locales fall back to English).
- A hidden (background) window does not tick CSS transitions. The GIFs were therefore made by pausing the real CSS transitions and seeking them frame by frame. Timing is exact, but the GIF is not a screen recording.

Checked against how comparable products handle this.

## Screenshots (dev build, isolated profile, made-up data)

All in `proto-shots/` in the worktree:

- Hidden: `light-01-hidden.png`, `dark-01-hidden.png`, `light-03-hidden-sliver.png`, `dark-03-hidden-sliver.png`
- Revealed per variant: `{light,dark}-02-revealed-{float,dock,sliver}.png`
- Menu with the two rows: `light-04-menu.png`, `dark-04-menu.png`
- Always (docked): `light-05-always-docked.png`, `dark-05-always-docked.png`
- Settings control: `light-06-settings.png`
- Narrowest window (600px, the app minimum): `narrow-600-hidden.png`, `narrow-600-revealed-float.png`
- First launch: `firstrun-1-docked.png`, `firstrun-2-edge-glow.png`
- Motion, float → dock → sliver, reveal + hide: `reveal-hide-float-dock-sliver-realspeed.gif`, `reveal-hide-float-dock-sliver-quarter-speed.gif`

## Files

New: `components/app-rail/AppRailAutohideSlot.tsx` (slot + state machine), `app-rail-autohide.ts` (timings, dev keys), `app-rail-menu-request.ts` (right-click → menu), `AppRailVisibilityRows.tsx`.
Changed: `AppShellLeftColumn.tsx` (uses the slot), `app-rail-layout.ts` (`selectAppRailDocked`; rail width is 0 in hover mode), `use-app-chrome-layout.ts` and `AppWorkspaceShell.tsx` (titlebar math uses the docked width), the Customize/More menus, `AppRailExperimentalSetting.tsx`, `main.css`, `en.json`, settings type + main-side sanitizer.
