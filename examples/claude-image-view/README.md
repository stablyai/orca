# Orca Image View

An opt-in Claude Code mod adapted from [Jarrod Watts’ Claude Image View](https://github.com/jarrodwatts/claude-image-view). It shows numbered thumbnails above Claude’s terminal prompt while `[Image #n]` tags remain in the draft, and clears them when the draft clears.

Orca's Kitty renderer accepts image bytes (`t=d`), but does not open files named by terminal output (`t=f`). The original mod passes a filename to Claude's `Image` element. This adaptation reads the PNG through Claude's mod API and uses `source={{ png: base64 }}` instead. Image data travels with the terminal stream, including over SSH; the Orca client never needs access to the CLI host's cache directory.

## Run in Orca

Requires Claude Code 2.1.287 or newer with mods enabled, and Orca's **Inline images** terminal setting enabled. This is a Claude Code mod, not an Orca `orca-plugin.json` plugin. It does not install automatically or change Claude settings.

From an Orca terminal, point Claude to this directory in your checkout:

```sh
claude --plugin-dir /absolute/path/to/orca/examples/claude-image-view
```

Use a quoted absolute path when it contains spaces. On Windows the same command accepts a Windows path. For a reusable Orca Claude agent launch, add `--plugin-dir` with that absolute path to its additional CLI arguments.

Paste a screenshot into Claude's prompt. Its numbered tile should appear without another keystroke. Paste another image, delete an image tag, then send the draft: the matching tiles should update and clear. Avoid loading the original `image-view` mod at the same time, since both draw above the prompt.

For SSH or WSL, place this directory on the execution host and pass its **host-side** path to Claude. `CLAUDE_CODE_TMPDIR`, if set, must name Claude's cache root on that same host. On Windows, set it to the cache root used by your Claude installation; this example does not guess Windows cache locations. On macOS/Linux the default is `/tmp/claude-<uid>`, matching the upstream mod.

## Limits and safety

- Previews cover the first four distinct image tags, with PNGs limited to 2 MiB each and 8 million pixels. Large, unreadable, invalid, or missing PNGs show `no preview`; the original attachment is unaffected.
- Narrow or short prompt bands show only the tiles that fit. Other attachments still reach Claude normally.
- The draft is checked every 200 ms because image paste does not reliably emit a prompt edit event. Successfully read PNGs are cached only while their tags remain in the current session's draft. Session changes discard the cache even when image numbers are reused.
- The mod reads only the active session's numbered PNG cache entries. It refuses symlink image files, makes no network requests, writes no files, and does not modify the prompt. On macOS/Linux it runs `id -u` to locate the default cache root if `CLAUDE_CODE_TMPDIR` is absent.
- Claude Desktop is unaffected. Other agents and Orca's native chat composer retain their existing behavior.

## Verify

Run from the Orca repository root. The environment flag applies only to these test processes; it does not save a setting or alter any session.

```sh
ORCA_BACKGROUND_LAUNCH=1 CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1 claude plugin validate examples/claude-image-view
ORCA_BACKGROUND_LAUNCH=1 CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1 claude plugin test examples/claude-image-view
ORCA_BACKGROUND_LAUNCH=1 pnpm test config/scripts/claude-image-view-layout.test.ts
```

Runtime-owned types live in `types.ts`; preview bytes remain in the mod’s bounded memory rather than crossing reactive state calls. Claude can generate its API declarations for local type checking; see the [official mod type workflow](https://code.claude.com/docs/en/plugins/mods/create#get-the-types-for-your-build).

## Attribution

Adapted from upstream commit `12795b62f1c17f4b36c980e33672fbdff3a6731a` (MIT). The original copyright and permission notice are preserved in [LICENSE](LICENSE). The draft scanner, PNG header reader, tile layout, render hooks, and initial tests derive from that project. Changes add direct PNG transport, bounded previews, cache/session handling, and safer fallback behavior.
