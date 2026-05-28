# Browser Tab Favicons

## Problem

- Issue #2967: browser tabs in Orca all show the same generic icon, making multiple browser tabs hard to distinguish visually.
- `src/renderer/src/components/tab-bar/BrowserTab.tsx:155` always renders a blue `Globe`, even when the tab state already has a page favicon.
- `src/shared/types.ts:515` and `src/shared/types.ts:531` define `faviconUrl` on `BrowserPage` and mirrored `BrowserWorkspace`.
- `src/renderer/src/components/browser-pane/BrowserPane.tsx:3489` listens for Electron `page-favicon-updated` and writes sanitized `http`, `https`, or `data:image/` favicon URLs into page state.
- `src/renderer/src/store/slices/browser.ts:288` mirrors the active page's favicon onto the browser workspace that the tab strip receives.
- Remote/web runtime tab contracts do not currently carry favicon data. `BrowserTabInfo` exposes metadata such as page ID, URL, title, active state, worktree, and profile; `RuntimeMobileSessionBrowserTab` also omits favicon fields.

## Goal

Show the loaded page favicon in each browser tab when `tab.faviconUrl` is available. Keep the existing globe as the fallback for blank tabs, failed/no-favicon pages, and image load failures.

## Non-goals

- Do not fetch favicons manually or add network requests from the tab strip.
- Rendering an `http(s)` favicon in an `img` may still make the renderer load that URL. Do not add imperative discovery/fetching; accept image load failure and fall back.
- Do not change persisted browser-session shape; `faviconUrl` already exists.
- Do not change remote browser RPC contracts. Remote favicons can follow later if the runtime surfaces them.
- Do not recolor site favicons. Use the image as provided and only apply shape/fit treatment.

## Design

1. Add a small browser-tab favicon renderer in `BrowserTab.tsx`.
   - If `tab.faviconUrl` is non-empty and has not failed for the current URL, render an `img` with the same 12px footprint as the current globe.
   - Use the existing tab spacing (`size-3 mr-1 shrink-0`), `object-contain`, `draggable={false}`, and a tiny radius so square, transparent, and irregular favicons fit without shifting the label or interfering with tab dragging.
   - Keep `alt=""` and `aria-hidden` because the visible tab label already names the tab.

2. Preserve and reuse the globe fallback.
   - Render the existing blue globe when `faviconUrl` is missing, empty, or the favicon image errors.
   - Track the failed favicon URL locally per rendered tab and clear that failure whenever `tab.id` or `tab.faviconUrl` changes.
   - Do not add tab-level URL parsing, timers, or loading heuristics. `BrowserTab` should reflect the model it receives; favicon invalidation belongs in `BrowserPane` and the browser store.
   - Treat `tab.faviconUrl` as a model-owned, already-sanitized display URL. Current writers only persist `http`, `https`, and `data:image/` values; any future writer or external sync path that sets this field must enforce the same source-side whitelist instead of moving discovery or validation into the tab strip.

3. Keep tab layout stable.
   - The icon area must remain `size-3 mr-1 shrink-0` for both favicon and fallback.
   - The label's existing truncation and loading dot behavior should remain unchanged.
   - Avoid adding colors outside the current component style. The fallback can retain the existing `text-blue-500` because this change is replacing it only when a site favicon exists.

4. Add focused tests for favicon/fallback behavior.
   - Cover rendering the favicon image when `faviconUrl` is present.
   - Cover falling back to the globe after image error.
   - Cover resetting an image-error fallback when `faviconUrl` changes.
   - Use the existing node Vitest style with mocks or extract a tiny pure decision helper; do not assume Testing Library/jsdom is available unless adding that dependency is explicitly in scope.

## Edge cases

- Blank/new tabs have `faviconUrl: null` and must keep the globe.
- BrowserPane clears `faviconUrl` only for tracked navigations that pass through its gated `did-start-loading` path. Reloads and in-page navigations may retain the current favicon until the source model changes; the tab component should not clear it on `loading` alone.
- A late `page-favicon-updated` from an old document would be a BrowserPane/model race, not a tab rendering problem. If that shows up in testing, fix it with a load generation or current-URL guard at the event source.
- Broken favicon URLs must fall back to the globe without collapsing spacing.
- Authenticated, intranet, partition-specific, or SSH/remote-only favicon URLs may fail when rendered by the app renderer even though the page itself loaded them. This is acceptable; fall back without retry loops or local proxying.
- Data-image favicons are already allowed by `BrowserPane`; the tab renderer must not reject them.
- Remote runtime browser pages do not provide new favicon data yet. Web-session mirroring may preserve an existing local favicon for an already-known remote page, including after the remote page URL changes; newly mirrored remote tabs should keep the fallback until the remote contract carries a favicon.
- Multiple browser tabs with different `faviconUrl` values must maintain independent image-error state.
- Switching the active page inside a browser workspace must update the outer tab favicon through the existing workspace mirror; do not read nested page state directly from `BrowserTab`.

## Rollout

1. Implement the favicon/fallback renderer in `BrowserTab.tsx`.
2. Add unit coverage around `BrowserTab` favicon rendering and fallback reset behavior.
3. Run targeted tests, then `pnpm typecheck` and `pnpm lint`.
4. Validate in Electron with at least two browser tabs on distinct sites plus fallback cases.
