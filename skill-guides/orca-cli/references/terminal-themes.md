# Build a Terminal Theme

For a user's custom theme, create a Warp-format `.yaml` file. Orca's **Import from YAML**
accepts this format even when Warp is not installed. Adding a built-in theme to Orca's
source is a separate workflow below; do not change the app catalog for a personal import.

## Importable palette

Use a descriptive, distinct `name`, quoted `'#rrggbb'` colors, `background`, `foreground`,
and all eight colors under each of `terminal_colors.normal` and `terminal_colors.bright`.
`cursor` is optional; Orca also accepts `accent` as its fallback. Start from this complete
example and replace the colors to suit the requested design:

```yaml
name: Quiet Night
background: '#1a1b26'
foreground: '#c0caf5'
cursor: '#c0caf5'
terminal_colors:
  normal:
    black: '#15161e'
    red: '#f7768e'
    green: '#9ece6a'
    yellow: '#e0af68'
    blue: '#7aa2f7'
    magenta: '#bb9af7'
    cyan: '#7dcfff'
    white: '#a9b1d6'
  bright:
    black: '#414868'
    red: '#ff899d'
    green: '#b0dc7c'
    yellow: '#f0bc7e'
    blue: '#8db0ff'
    magenta: '#cbaaff'
    cyan: '#9de7ff'
    white: '#c0caf5'
```

Orca requires valid background, foreground, and at least one ANSI color to accept a file,
but provide the full 16-color palette so programs do not inherit unintended colors.
Keep foreground and bright-black text readable against the background, and preserve the
ANSI color roles programs use for errors, success, warnings, and links. Background images
and gradients are not supported; use solid colors. This importer does not map arbitrary
xterm fields such as `selectionBackground` or `cursorAccent` from YAML.

Create dark and light variants as separate files with distinct names, such as
`Quiet Night Dark` and `Quiet Night Light`. Orca infers the imported mode from the
background color; a `details: lighter` or `details: darker` label does not override that.
The mode label does not automatically pair or select the two themes.

In desktop Terminal settings, choose **Import from YAML**, select the file or folder,
review the preview and skipped-file reasons, and apply the selected themes. Imported
palettes become available in both global and project theme pickers. Select each variant
for its dark or light slot; globally, enable the separate light theme if needed. A project
light selection enables that separation for the project. Unset project slots follow the
global selection rules. Importing alone does not assign a theme to a project.

## Set a project theme through the CLI

Use `repo show --repo <selector> --json` to inspect its current `terminalTheme`.
Set one mode without changing the other:

```text
ORCA repo set-theme --repo id:<repo-id> --mode dark --theme "Dracula" --json
ORCA repo set-theme --repo id:<repo-id> --mode light --theme custom:warp:quiet-light --json
ORCA repo set-theme --repo id:<repo-id> --mode light --theme inherit --json
```

Use the exact built-in catalog name or the imported theme's `selectionValue`; importing
and selecting are separate operations. `inherit` clears that mode's project override.
The command supports local and SSH repo rows; it rejects paired-runtime rows,
matching the settings UI. It saves a selection, not a theme file,
and an unavailable selection falls back to global. Theme creation/import and terminal
appearance mode are not changed by this command.

Deliver the files and import instructions. Do not edit Orca's live settings database or
claim import, selection, or visual verification unless actually performed. If working
remotely, make the files accessible to the desktop doing the import.

## Add a built-in selectable theme in an Orca checkout

Inspect `src/shared/terminal-themes/index.ts` and its category modules. Add a uniquely
named `ITheme` palette to the appropriate existing category, using its established shape.
For a new category, include it in `THEME_CATEGORIES`. Normal ANSI keys are flat (`red`,
`green`, etc.); bright keys are `brightRed`, `brightGreen`, etc., unlike the YAML nesting.
The catalog rejects duplicate names.

The renderer derives selectable options from the shared catalog; there is no separate
project list to update. Keep existing names stable because saved selections reference
them. Run the existing shared catalog and renderer theme tests relevant to the change,
plus renderer typechecking and the changed-code-quality gate. Follow the checkout's
background-launch policy for all tests and rendered checks.
