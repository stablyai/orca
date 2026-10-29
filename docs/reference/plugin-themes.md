# Plugin themes

Plugins contribute three kinds of theme through `orca-plugin.json` `contributes`:
`themes` (app colors), `terminalThemes` (an ANSI palette) and, separately, icon themes.
Each entry is `{ "id", "label", "path" }` pointing at a JSON file of at most 16 KiB.

## App themes

```json
{
  "schemaVersion": 1,
  "base": "dark",
  "tokens": { "--background": "#1b1430", "--foreground": "#e8e0ff" }
}
```

- `schemaVersion` is optional for app themes and must be `1` when present.
- `base` (`light` or `dark`) picks the slot the theme fills: users choose a Light theme and a
  Dark theme separately, and Orca paints the one for its current mode (following the OS under
  System). Contribute one theme of each base to ship a pair; installing it fills both slots.
- `--background` and `--foreground` are required. Every other public token is optional; an
  omitted token is derived from the ones you set (cards from `--background`, sidebars lifted a
  step off `--background` so the left sidebar keeps a visible edge, text from `--foreground`,
  sidebar accents from `--accent`, rings from `--primary`, and so on), so a two-token theme still
  colors the whole app.
- [Theme tokens](plugin-theme-tokens.md) lists every public token and what it falls back to
  when omitted. Other variables cannot be set.
- Values must be colors: hex, a color function (`rgb`, `hsl`, `oklch`, …) or a color name.
  `transparent`, `currentColor`, CSS-wide keywords, lengths, `calc()`, `var()` and `url()` are
  refused.
- Each text/surface pair (for example `--background`/`--foreground`,
  `--primary`/`--primary-foreground`) must be opaque with at least 4.5:1 contrast; a pair that
  fails is dropped and keeps Orca's built-in colors.
- Trust and approval dialogs always use Orca's own colors, whatever theme is active.
- `pnpm validate:plugin` refuses unknown keys, tokens and slots in every theme file. Orca itself
  skips them, so a theme that sets a token added in a newer release still loads on older ones.

### Code colors

An app theme also colors the code editor: its background, text, line numbers, cursor and
selection follow the theme's tokens. To color code itself, add `tokenColors` (Orca 1.4.245 and
later) in the same shape as a VS Code theme's, so most VS Code theme lists paste in unchanged (`validate:plugin` flags entries without a `scope` and any setting other than these two):

```json
{
  "base": "dark",
  "tokens": { "--background": "#1b1430", "--foreground": "#e8e0ff" },
  "tokenColors": [
    { "scope": "comment", "settings": { "foreground": "#8f84ad", "fontStyle": "italic" } },
    { "scope": ["keyword", "storage"], "settings": { "foreground": "#ff7ad9" } },
    { "scope": "string", "settings": { "foreground": "#a8e6a1" } },
    { "scope": "constant.numeric", "settings": { "foreground": "#ffb86c" } },
    { "scope": "entity.name.function", "settings": { "foreground": "#82cfff" } },
    { "scope": "markup.heading", "settings": { "foreground": "#ff7ad9", "fontStyle": "bold" } }
  ]
}
```

- `scope` is a TextMate scope or a list of them (a comma-separated string works too). Scopes
  follow the [TextMate naming convention](https://macromates.com/manual/en/language_grammars#naming_conventions):
  `comment`, `string`, `constant.numeric`, `keyword.control`, `keyword.operator`,
  `entity.name.function`, `entity.name.type`, `variable`, `punctuation`, `markup.heading`,
  `markup.underline.link`, `invalid`, and so on. A scope also colors everything beneath it
  (`keyword` covers `keyword.control.flow`); the longest match wins, then the later rule.
- `settings.foreground` is a hex color; `settings.fontStyle` is `italic`, `bold`, `underline`,
  `strikethrough`, a space-separated combination, or `""` for none. `name` is allowed and ignored.
- Orca applies them to its built-in languages and to plugin syntaxes alike. Selectors with
  spaces (descendant scopes) and `semanticTokenColors` are not read.
- A color under 3:1 contrast with the editor background is dropped, and anything a theme leaves
  out keeps the built-in light or dark code colors.

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
