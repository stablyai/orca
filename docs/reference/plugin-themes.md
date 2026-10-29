# Plugin themes

Plugins contribute three kinds of theme through `orca-plugin.json` `contributes`:
`themes` (app colors), `terminalThemes` (an ANSI palette) and, separately, icon themes.
Each entry is `{ "id", "label", "path" }` pointing at a JSON file of at most 16 KiB.

## App themes

```json
{ "base": "dark", "tokens": { "--background": "#1b1430", "--foreground": "#e8e0ff" } }
```

- `base` (`light` or `dark`) becomes the app's light/dark mode while the theme is selected.
- `--background` and `--foreground` are required. Every other public token is optional; an
  omitted token is derived from the ones you set (cards and sidebars from `--background`, text
  from `--foreground`, sidebar accents from `--accent`, rings from `--primary`, and so on), so a
  two-token theme still colors the whole app.
- The public tokens are `PLUGIN_APP_THEME_TOKENS` in
  `src/shared/plugins/plugin-theme-artifact.ts`. Other variables cannot be set.
- Values must be colors: hex, a color function (`rgb`, `hsl`, `oklch`, …) or a color name.
  `transparent`, `currentColor`, CSS-wide keywords, lengths, `calc()`, `var()` and `url()` are
  refused.
- Each text/surface pair (for example `--background`/`--foreground`,
  `--primary`/`--primary-foreground`) must be opaque with at least 4.5:1 contrast; a pair that
  fails is dropped and keeps Orca's built-in colors.
- Trust and approval dialogs always use Orca's own colors, whatever theme is active.

## Terminal themes

```json
{
  "schemaVersion": 1,
  "mode": "dark",
  "terminal": { "background": "#1b1430", "foreground": "#e8e0ff", "red": "#ff6b8b" }
}
```

Colors are hex. A palette needs `background`, `foreground` and at least one ANSI color. When a
user selects it, Orca saves a copy of the palette in settings so hosts, headless servers and
relays answer terminal color queries without the plugin loaded.
