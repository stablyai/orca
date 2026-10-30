# Component Fixtures

Render one renderer component in isolation and screenshot it headlessly in about a second, without booting Electron. Use it as the fast verify loop for presentational UI changes. Use the `$electron` skill when the change depends on real app state, IPC, terminals, or window chrome.

## Writing a fixture

Put a `*.fixture.tsx` file next to the component. Each named export built with `defineFixture` is one fixture:

```tsx
import { defineFixture } from '../../component-fixtures/component-fixture'
import { DeleteWorktreeDirtyChangeHint } from './DeleteWorktreeDirtyChangeHint'

export const dirty = defineFixture({
  width: 360,
  render: () => <DeleteWorktreeDirtyChangeHint changeCount={3} checkState="checking" />
})
```

Optional fields:

- `store`: partial `AppState` merged into the store before render. The store starts from slice defaults plus `getDefaultSettings()`.
- `setup()`: runs before render, for example to override a `window.api` method.
- `interact(frame)`: runs after first paint, for example clicking a trigger so an open popover is captured. Content portaled to `<body>` (popovers, menus, dialogs) is included in the screenshot.
- `width`: frame width in CSS pixels. The height always fits the content.

Fixture ids are the file path under `src/renderer/src/` with `components/` and `.fixture.tsx` removed, followed by the export name. For example, `sidebar/DeleteWorktreeDirtyChangeHint:dirty`.

Every fixture renders inside `I18nProvider`, `TooltipProvider`, and the theme class. `window.api` is the web client's preload bridge (`installWebPreloadApi`) with no runtime paired. Calls that need a runtime reject, and namespaces without a web implementation return the web fallback defaults. The web-client flag is cleared, so components render their desktop branches.

Fixtures are dev-only. They load through `import.meta.glob` in the fixture explorer, which is not a production build input. Oxlint rejects static imports of `*.fixture` modules.

## Screenshots

```bash
pnpm fixtures:shot sidebar/DeleteWorktreeDirtyChangeHint:dirty   # one fixture
pnpm fixtures:shot sidebar/DeleteWorktreeDirtyChangeHint --theme both   # every fixture in a file, both themes
pnpm fixtures:shot 'ui/*' --scale 2   # glob, at 2x
pnpm fixtures:shot --list
pnpm fixtures:shot --stop
```

PNGs go to `.cache/fixtures/` (override with `--out`), and the command prints their paths. Read them with your image viewer tool. Render errors and page console errors are printed for each fixture, and any failure makes the command exit non-zero.

The first call starts a detached server: Vite (`config/vite.fixtures.config.ts`, which extends `vite.web.config.ts`) plus one headless Chromium. The first call takes 10–20 seconds. After that, each shot takes about 100 ms. The first shot after a source edit takes 1–2 seconds because the page reloads. The server restarts itself when the fixture scripts change and exits after 20 idle minutes.

Chromium resolution order: `ORCA_FIXTURES_BROWSER` (an executable path), then the Playwright-managed `chromium-headless-shell`, then an installed Chrome or Edge. Every option runs headless, so screenshots never open a window or take focus.

## Browsing

`pnpm dev:fixtures` serves the explorer for humans. Open `/fixtures` for the index, or `/fixtures?id=sidebar/DeleteWorktreeDirtyChangeHint:dirty&theme=light` for a single fixture.

## MCP

`.mcp.json` registers `orca-component-fixtures`, a stdio server at `config/scripts/component-fixtures/fixtures-mcp-server.mjs`. It has two tools:

- `list_fixtures({ filter? })`
- `screenshot_fixture({ id, theme?, scale? })`: returns the PNGs inline (up to 6) along with their paths.
