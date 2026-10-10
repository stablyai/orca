# Omarchy theme

On [Omarchy](https://omarchy.org) Linux, Orca can follow the active Omarchy theme: the UI chrome, the editor, and the terminal re-skin within about a second of `omarchy theme set <name>`, without a restart.

## Install the template

Omarchy renders every `*.tpl` in `~/.config/omarchy/themed/` on each theme switch. Orca ships its template in this repo:

```sh
./omarchy/install-omarchy-theme-template.sh
```

The script symlinks `omarchy/orca.json.tpl` to `~/.config/omarchy/themed/orca.json.tpl` and re-renders the current theme. It is safe to re-run. Because it is a symlink, moving or deleting this checkout breaks it; re-run the script from the new location (or copy the file instead of linking it, and re-copy after template updates).

Manual equivalent:

```sh
mkdir -p ~/.config/omarchy/themed
ln -sfn "$PWD/omarchy/orca.json.tpl" ~/.config/omarchy/themed/orca.json.tpl
omarchy-theme-refresh
```

Each switch then writes `~/.local/state/omarchy/current/theme/orca.json`: a small seed palette (mode, backgrounds, foregrounds, accent, selection, the six base hues, `color0`–`color15`, and terminal cursor/selection). Orca derives everything else.

## Select it in Orca

- **UI chrome:** Settings → Appearance → Theme → **Omarchy**. Orca's light/dark mode follows the Omarchy theme's `mode`.
- **Terminal:** Settings → Appearance → Terminal Themes → pick **Omarchy** under _Imported_. It is stored as a custom terminal theme (`custom:omarchy:live`) that Orca refreshes on every switch, so it also works as the light-mode terminal theme.

The two are independent; select either or both.

## What Orca changes

Only colors. The derivation lives in `src/shared/omarchy-theme-palette.ts`:

- shadcn core tokens, `sidebar-*`, `worktree-sidebar-*`, `chat-*` colors, diff and git decoration colors, git graph lanes, status and workspace-status tones, charts, and the editor surface.
- `terminal-pane-title-on-dark-*` for dark themes or `terminal-pane-title-on-light-*` for light themes — only the family matching the theme's mode, since the other family is chosen by terminal background contrast and keeps its stock values.
- Monaco gets an `orca-omarchy` theme built from the same seed.

Never themed: `--orca-security-*` (security prompts must stay recognizable), layout variables such as `--chat-content-max-width`, and the UI font. Omarchy's font setting is not applied.

## When the option does not appear

The Omarchy choices only show when Orca runs on Linux **and** `~/.local/state/omarchy/current/theme/orca.json` exists and parses. If they are missing:

1. Confirm Omarchy is installed (`omarchy theme list`).
2. Run the install script above, then check the rendered file exists.
3. Make sure the file has no `{{` left in it. A theme missing a color leaves its placeholder unresolved; Orca rejects such a file and keeps the last good palette.

macOS, Windows, Linux without Omarchy, and the web client see no new UI. The file is always read from the machine Orca runs on, never from an SSH or remote host.

If the file disappears or becomes invalid while selected, Orca keeps the last valid palette until the next valid switch. Choosing System, Dark, or Light (or another terminal theme) stops the watcher and restores the stock theme.
