# Plugin Appearance Protocol

Appearance plugins change presentation without changing Orca behavior, labels, command routing, permissions, DOM structure, or interaction semantics. The host parses every artifact and applies only public semantic slots; plugins cannot inject CSS, selectors, HTML, or scripts.

## Manifest contributions

```json
{
  "contributes": {
    "themes": [{ "id": "square", "label": "Square", "path": "themes/square.json" }],
    "iconThemes": [{ "id": "minimal", "label": "Minimal", "path": "icons/theme.json" }],
    "terminalThemes": [{ "id": "console", "label": "Console", "path": "terminal/console.json" }]
  }
}
```

Contribution IDs are plugin-local. The host exposes them as `plugin:<publisher>.<plugin>/<contribution>` and ignores contributions from disabled, unapproved, invalid, or revoked plugins.

## Application theme artifact

Schema version 1 is compatible with upstream Orca and accepts color tokens only. Schema version 2 adds region, geometry, component-state, shadow, and motion tokens. Schema version 3 adds bounded canvas/sidebar gradient layers. Schema version 4 adds contained PNG textures, and schema version 5 can link an app theme to a terminal theme contributed by the same plugin. Plugins still cannot inject selectors, arbitrary URLs, functions, or declarations.

```json
{
  "schemaVersion": 5,
  "base": "dark",
  "tokens": {
    "--background": "#101010",
    "--right-sidebar": "#181818",
    "--appearance-control-radius": "0px",
    "--appearance-shadow-control": "3px 3px 0 0 #000000",
    "--appearance-control-active-offset": "2px",
    "--appearance-state-selected": "#304050",
    "--appearance-state-selected-foreground": "#ffffff",
    "--appearance-state-selected-border": "#000000",
    "--appearance-state-border-width": "2px",
    "--appearance-worktree-sidebar-background-image": "repeating-linear-gradient(45deg, #ffffff08 0px, #ffffff08 1px, transparent 1px, transparent 8px)",
    "--motion-enter": "260ms",
    "--motion-ease-out": "cubic-bezier(0.2, 1.4, 0.4, 1)"
  },
  "textureAssets": {
    "--appearance-right-sidebar-background-image": "textures/paper.png"
  },
  "terminalThemeContributionId": "console"
}
```

The exact public allowlist is `PLUGIN_APP_THEME_TOKENS` in `src/shared/plugins/plugin-theme-artifact.ts`. It covers:

- semantic shadcn colors and editor/settings surfaces;
- left, worktree, and right sidebar surfaces, foregrounds, accents, borders, and focus rings;
- hover, selected, and current component background/foreground states;
- optional solid state borders and bounded canvas, worktree-sidebar, and right-sidebar gradient layers;
- control, panel, overlay, and pill radius, plus border widths and shadows;
- bounded control hover/press offsets and base, hover, and active control shadows;
- fast/base/enter/exit/spinner durations, movement distance and scale, and easing curves.

Textures must be small PNG files contained by the plugin. A terminal link must reference a terminal theme declared by the same plugin; selecting the app theme then updates the matching light or dark terminal preference while the reverse stays under explicit user control. If a plugin omits right-sidebar slots but supplies matching sidebar slots, the renderer uses those sidebar values as the right-sidebar fallback. Missing tokens otherwise retain host defaults, and uninstalling or disabling a plugin falls back safely.

`--orca-security-*` is private. Marketplace provenance, installation, consent, and permission surfaces reset appearance values to host-owned defaults.

### Bundled curated pack

Orca includes `stablyai.orca-curated-themes` as an enabled, declarative appearance
sampler. It contributes seven neutral style presets — Neo Brutalism light/dark,
Cupcake Cartoon, Synthwave Future, Aurora Glass, Paper Light, and Stage Dark —
with matching terminal palettes and local paper/stage textures. The pack has no
executable entry point or capabilities. Application themes are selected under
Settings → Appearance, and linked terminal palettes follow only when the user
chooses that app theme.

## Icon theme artifact

```json
{
  "schemaVersion": 1,
  "icons": {
    "file": "file.svg",
    "folder": "folder.svg",
    "folder-open": "folder-open.svg",
    "sidebar.search": "search.svg"
  },
  "fileNames": { "readme.md": "readme.svg" },
  "fileExtensions": { "tsx": "react.svg" }
}
```

The host supports the bounded slots in `PLUGIN_ICON_THEME_SLOTS`. File-name matching wins over extension matching, then the `file` slot is used. SVG files are size-bounded, contained within the plugin directory, stripped of comments, and rejected if they contain active content, external references, event handlers, inline styles, or unsupported elements. Sanitized SVG is transported as data, never inserted as markup.

## Terminal theme artifact

```json
{
  "schemaVersion": 1,
  "mode": "dark",
  "terminal": {
    "background": "#101010",
    "foreground": "#f0f0f0",
    "black": "#000000",
    "red": "#ff5555"
  }
}
```

Only normalized xterm color slots are accepted. A terminal theme must include background, foreground, and at least one ANSI color. Plugin terminal themes join the built-in and imported catalogs and are selected independently for light and dark terminal modes.

## Runtime and compatibility

Desktop IPC and paired-host RPC expose the same read-only registries. Paired clients call additive `plugins.listThemes`, `plugins.listIconThemes`, `plugins.loadIconTheme`, and `plugins.listTerminalThemes` methods. Clients treat an unknown method from an older host as an empty registry, so mixed versions keep the built-in appearance.

Theme and icon selection values are optional settings fields. Unknown or malformed IDs normalize to empty selections. No appearance contribution changes workspace data or requires a git worktree, so folder workspaces and SSH-backed workspaces use the same renderer contract.
