# Claude rich output

Opt-in terminal presentation based on [NeonCoat](https://github.com/NateCC0902/NeonCoat),
commit `ed82d3a7c212d441962764f1d592589731b4bdbe`, by Nate Chia (MIT;
see LICENSE.neoncoat). Only `reply-markdown` and `reply-media` are included.
No status line, skill router, shell monitor, or other NeonCoat module is installed.

Enable **Settings → Terminal → Claude Rich Output**, then start a new Claude
terminal. Existing sessions keep their original plugins until restarted. Turning
the setting off restores the ordinary launch for new sessions. Global Claude
settings and other installed plugins are left alone.

This uses Claude's experimental function-hook plugin interface, tested with
Claude Code 2.1.310; compatibility with every CLI release is not guaranteed.
The modules also add formatting guidance to Claude's prompt. They do not change
its execution permissions, task lifecycle, or model transport.

## Execution host requirements

Node 24, `rsvg-convert` (librsvg), and `ffmpeg` must be installed on the machine
running Claude, including SSH hosts. MathJax and beautiful-mermaid ship with
Orca; no npm download or install happens when a session starts. PNG files need
no converter; other images and video need the corresponding tools. Missing
tools produce a visible error with the source and a retry action.

Local macOS, Linux, Windows and updated SSH hosts resolve their own bundled
resources. An older server without this integration ignores the opt-in marker
and retains its ordinary CLI behavior. Windows-to-WSL launches currently retain
ordinary rendering: Windows resource paths are never injected into the guest.
Browser/mobile viewers use the host's launch configuration and terminal graphics
support; this setting does not add a separate mobile renderer.

Inline Images must be enabled to display media. Formulas and diagrams are rasterized
at 3× resolution on an opaque background so they remain readable in both terminal
themes. The upstream palette is dark; optionally set `NEONCOAT_MEDIA_THEME=light`
in Claude's environment settings for a light canvas. This does not recolor images
that are already in the terminal history. A separately configured module with the
same plugin name takes precedence over the bundled copy. Orca checks the execution
host's selected Claude profile, applicable marketplace installs, user/project
skills directories, and explicit plugin paths before adding a bundled module.
Existing or explicitly disabled copies are reserved, so the switch cannot replace
or re-enable them. Unreadable plugin metadata leaves the ordinary launch intact.

## Orca adaptations

- XML-safe MathJax serialization, including cases, inequalities and ampersands.
- Private per-user media cache (POSIX mode 0700), rejecting unsafe existing directories.
- Atomic, versioned formula cache; coalesced requests; a 30-second render timeout
  with one retry for an aborted process.
- Resumed previews share one 30-second budget before the first prompt; converters
  receive the remaining time and unrendered blocks retain their source text.
- Inline PNG transport for small images and video frames across remote sessions.
- Native responses are committed before optional preview conversion; mounted rows
  update when the preview is ready.
- Asynchronous video loading with cancellation and visible retry states.
- Non-macOS conversion through ffmpeg; no unconditional macOS viewer command.
- Literal code fences remain literal, including backticks and bold markers.
- Tables and GitHub alert callouts have a `copy` button above the content, matching
  code cards. Tables and callouts copy their Markdown; code cards copy the code.

These sources are separate from Orca's generic terminal image implementation.
Image eviction/replay recovery is addressed independently. Disk caches are
best effort, not a permanent transcript archive. No automatic network image
fetches are performed by these modules.

## Validation

For local feature development, run `pnpm build:claude-rich-output` before `pnpm dev`.
Ordinary install, test, typecheck, and dev preparation build only shared workspace
packages. Desktop packaging, direct Orcad builds, and the Orcad template's target
builds prepare the rich-output bundle explicitly.

With the execution-host prerequisites installed, run `pnpm test:claude-rich-output`
to run the renderer regressions plus Claude's own plugin validation and hook tests.
This separate runner requires Claude Code and librsvg/ffmpeg, and is not part of
the ordinary CI unit suite. No model request is made by these checks.

The hook files run in Claude's isolated plugin VM, with its own JSX globals and API.
Their `tsconfig.json` files are standalone authoring configurations, separate
from Orca's Node/Electron projects. For an authoring typecheck, first load the plugin
from an owned folder in a compatible Claude CLI (which writes `.claude-plugin/types`),
then run `tsc --project tsconfig.json` in that plugin folder. Generated API
declarations are not part of Orca's bundle. Runtime hook validation and tests use
`claude plugin validate` and `claude plugin test`; no model request is needed.
