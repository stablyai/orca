# Plugin themes

Plugins contribute three kinds of theme through `orca-plugin.json` `contributes`:
`themes` (app colors), `terminalThemes` (an ANSI palette) and, separately, icon themes.
Each entry is `{ "id", "title", "path" }` (format 1 manifests used `label`) pointing at a JSON
file of at most 16 KiB, or 64 KiB for an icon theme.

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
  fails is dropped and keeps Orca's built-in colors. A pair you set only half of is checked
  against what the other half falls back to. Some checks drop only your token: `--text-link`
  needs 4.5:1 on `--editor-surface`, each `--git-decoration-*` 3:1 on `--sidebar`,
  `--chat-bold-foreground` 4.5:1 on the chat background and on `--chat-user-message`,
  `--chat-muted-foreground` 4.5:1 on the chat background and on code blocks, and
  `--worktree-sidebar-active`, `--chat-user-message`, `--chat-inline-code` (against the chat link
  color), `--chat-code-block` and the diff line and character tints 4.5:1 with the text drawn on
  them. Those surfaces, `--chat-inline-code`, `--chat-selection` and `--host-badge` may be
  translucent; they are checked as painted over the surface beneath.
- An omitted surface token paints exactly what Orca paints without a theme. The code editor's
  diff view and links keep Monaco's own colors unless the theme sets a diff token or
  `--text-link`. Setting only `--diff-added` and `--diff-removed` is enough; the line, gutter and
  changed-character tints follow them.
- When the user picks **Match terminal** or **Tinted** for the left sidebar, it ignores the
  theme's current-row colors (and, for Match terminal, its host badge colors); a chat set to
  match the terminal ignores the theme's chat and diff colors.
- Trust and approval dialogs always use Orca's own colors, whatever theme is active.
- `pnpm validate:plugin` refuses unknown keys, tokens and slots in every theme file. Orca itself
  skips them, so a theme that sets a token added in a newer release still loads on older ones.

### Code colors

An app theme also colors the code editor: its background, text, line numbers, cursor and
selection follow the theme's tokens. Users can also pick any app theme, of either base, as just
their editor theme (Settings → Appearance → Light/Dark editor theme); the editor then takes its
colors from `--editor-surface` (else `--background`), `--foreground`, `--muted-foreground`,
`--accent`, `--ring`, `--popover`, `--border` and `tokenColors`, while the rest of Orca keeps the
app theme. If those tokens can't make a legible editor, it uses Monaco's default colors. To
color code itself, add `tokenColors` (Orca 1.4.245 and later) in the same shape as a VS Code theme's, so most VS Code theme lists paste in unchanged (`validate:plugin` flags entries without a `scope` and any setting other than these two):

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

### Background image

An app theme may add one image painted behind the window's translucent surfaces:

```json
{
  "base": "dark",
  "tokens": { "--background": "#1b1430", "--foreground": "#e8e0ff" },
  "background": {
    "path": "images/dusk.webp",
    "videoPath": "images/dusk.mp4",
    "opacity": 0.35,
    "size": "cover",
    "position": "center"
  }
}
```

- `path` is a file inside the plugin: PNG, JPEG or WebP, static, 640×360 to 4096×4096, at most
  2 MB. Orca serves it only through its own image scheme and checks the bytes each time; an image
  that does not pass is not shown and the theme still applies. `validate:plugin` reports a
  missing file.
- `videoPath` (optional, Orca 1.4.254 and later) is a looping video played over `path`. It
  never shows controls. Orca checks it from the file's headers, without
  decoding it. Limits:
  - MP4 or WebM, with one video track and no audio track (encode with `-an`)
  - H.264, VP9 or AV1
  - at least 640×360, at most 2,304,000 pixels (for example 1920×1080)
  - at most 60 seconds and 8 MB

  Ship H.264 in MP4. It was the only codec decoded in hardware on every GPU tested (macOS,
  Windows and Linux with VA-API). Without a hardware decoder, H.264, VP9 and AV1 fall back to
  software. HEVC is refused because Chromium has no software decoder for it, so it plays on
  some machines and not others.

  For example: `ffmpeg -framerate 20 -i frame%04d.png -c:v libx264 -crf 18 -pix_fmt yuv420p -an -movflags +faststart dusk.mp4`.

  Each frame is a full-window composite, so 20 fps or less keeps the cost low.

  `path` stays required. Orca shows only the still image:
  - while the video loads
  - if the video cannot play
  - when the system asks to reduce motion
  - in earlier releases, which ignore `videoPath`

  The video pauses on its current frame while the window is not focused (including hidden or
  minimized) and while a dialog is open.

  Animated WebP, APNG and GIF are not supported: each frame is decoded in software, which costs
  several times the CPU of a video.

- `opacity` (0 to 1, default 1) is how strongly the image shows through the theme's
  `--background`; `size` is `cover` (default), `contain` or `tile` (a video covers instead);
  `position` is `center` (default), `top`, `bottom`, `left` or `right`.
- The image and video are never blurred. Sidebars, editors and pages stay opaque; it
  shows through terminals and agent chats when the user's terminal Background Opacity is below 1.
  Chat text sits on the chat canvas at that opacity (at least 0.8); message bubbles, code blocks,
  approval and question cards, the composer and menus stay opaque. A chat split beside terminals
  in one tab stays opaque.
- Orca releases without background images ignore the field (`validate:plugin` on them reports it).

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

## Icon themes

`contributes.iconThemes` points at a JSON file that maps files and folders to SVG icons. Paths
are relative to the plugin root. The map names match the common JSON file icon theme format.
To port such a theme, keep the keys you want and replace each value: those themes map a key
to an icon definition ID, while Orca needs the SVG file's path, which is that definition's
`iconPath`. Large themes have far more entries than the 512-mapping limit, so pick the most
common names.

```json
{
  "schemaVersion": 1,
  "icons": {
    "file": "icons/file.svg",
    "folder": "icons/folder.svg",
    "folder-open": "icons/folder-open.svg"
  },
  "fileNames": { "readme.md": "icons/readme.svg" },
  "fileExtensions": { "ts": "icons/typescript.svg", "d.ts": "icons/typescript-def.svg" },
  "folderNames": { "src": "icons/folder-src.svg", "docs": "icons/folder-docs.svg" },
  "folderNamesExpanded": {
    "src": "icons/folder-src-open.svg",
    "docs": "icons/folder-docs-open.svg"
  }
}
```

- `icons` holds the generic `file`, `folder` and `folder-open` icons.
- For a file, Orca checks `fileNames`, then the longest matching `fileExtensions` key (so
  `d.ts` beats `ts`), then `icons.file`.
- For a folder, Orca matches the folder's own name, not its path. A closed folder checks
  `folderNames`, then `icons.folder`. An open folder checks `folderNamesExpanded`, then
  `icons["folder-open"]`, then falls back like a closed folder. If you set `folder-open`, give
  each named folder an expanded icon too, or it shows the generic open folder when expanded.
  Orca releases up to 1.4.245 ignore `folderNames` and `folderNamesExpanded`. They show only
  the generic icons, and an open folder without `folder-open` gets Orca's built-in icon.
- Keys are case-insensitive. Two keys that differ only in case are refused. Name keys can't
  contain `/` or `\`, so keys qualified by a parent folder (`src/components`) are not
  supported.
- These icons appear in the file explorer, Source Control, diff and conflict file trees, tabs,
  Quick Open, search results and the remote folder browser.
- The theme file can be at most 64 KiB. A theme can have at most 512 mappings across all maps
  and 512 distinct SVGs. Each SVG can be at most 64 KiB, and all of a theme's SVGs together at
  most 4 MiB. An SVG painted only with `currentColor` takes the row's text color. Any other SVG
  keeps its own colors.
- `rootFolder`, `rootFolderNames`, `languageIds` and font icons aren't supported.
  Orca's explorer has no workspace-root row for a root icon. `pnpm validate:plugin` flags these
  keys, and Orca skips them at runtime.
