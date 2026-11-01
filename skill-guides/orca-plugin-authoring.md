---
name: orca-plugin-authoring
description: >-
  Build, debug, test, and publish Orca plugins end to end: app, terminal, and icon themes,
  syntaxes, language packs, custom editors, HTML or TSX components sidebar panels, palette
  commands and shortcuts, and Node worker commands that react to workspace and agent events.
  Use when the user asks to make, change, fix, or ship an Orca plugin, to add a panel,
  command, theme, editor, or language to Orca, or works in a folder with an orca-plugin.json.
  Use `orca-cli` only to list, enable, or disable plugins that are already installed.
---

# Orca Plugin Authoring

`ORCA` is a placeholder for the executable you resolved in the stub; substitute it before running.
Pass `--json` to every `ORCA plugin` command and branch on `error.code`, not on wording.

## Where things live

- **Your files:** a new folder, ideally its own Git repository, with `orca-plugin.json` at its
  root, made by `ORCA plugin create` (never overwrites). Paths are on the machine that runs Orca;
  with `--environment` pass an absolute path on that server.
- **Types:** `ORCA plugin types <dir>` (also run by `dev watch`) writes `.orca/types/` for every
  surface; the plugin's `tsconfig.json` extends `./.orca/types/tsconfig.json`. Never edit `.orca/`.
- **Ground truth:** the references below match this Orca. Read them instead of guessing.

## Pick the shape

Use the lowest `execution` profile that covers the request; it decides what the user must approve.

| The user asks for                                         | Build (manifest)                                                    | Start from                                       |
| --------------------------------------------------------- | ------------------------------------------------------------------- | ------------------------------------------------ |
| An app color theme                                        | `data`; `contributes.themes`                                        | `--template theme`                               |
| A terminal color palette                                  | `data`; `contributes.terminalThemes`                                | `--template terminal-theme`                      |
| File icons                                                | `data`; `contributes.iconThemes`                                    | `--template icon-theme`                          |
| Highlighting for a language                               | `data`; `contributes.syntaxes` (TextMate grammar)                   | `--template syntax`; example `orca-gleam-syntax` |
| Orca's UI in another language                             | `data`; `contributes.languagePacks`                                 | `--template language-pack`                       |
| A custom view or editor for a file type                   | `sandboxed-ui`; `contributes.customEditors`, optionally `newFiles`  | `--template editor`                              |
| A sidebar panel of lists, forms, buttons, status          | `sandboxed-ui`; `panels` entry `.tsx` with `"ui": "components"`     | `--template components`; example `hello-tsx`     |
| A sidebar panel needing its own HTML, canvas or libraries | `sandboxed-ui`; `panels` entry `.html` (or `.ts`/`.tsx`)            | `--template panel`                               |
| A palette command or shortcut for a built-in Orca action  | `declarative`; `commands[].action`, `keybindings`                   | hand-written; fields in `references/manifest.md` |
| A command that runs code, storage, secrets, terminal text | `trusted-worker`; `main`, `commands` (no `action`), `capabilities`  | example `hello-orca`                             |
| A panel backed by its own Node code, storage or settings  | `trusted-worker`; `main`, a panel, `capabilities`, `settings`       | `--template worker-panel`                        |
| Settings the user edits in Orca's Settings                | `contributes.settings` and `settings:own`                           | `references/manifest.md`                         |
| Reacting to workspace or agent status changes             | `trusted-worker`; `main`, `contributes.events`, `*:read` capability | example `hello-orca`                             |
| A virtual machine environment recipe                      | `declarative`; `contributes.vmRecipes`                              | hand-written; fields in `references/manifest.md` |

Examples are in `examples/plugins/` of github.com/stablyai/orca. Status bar items, sidebar cards,
task sources, connections, MCP servers, skills and hooks are reserved and not buildable yet: say
so instead of faking them. A panel cannot type into a terminal; only a worker
with `terminal:send` can.

## No build step

- `.ts`, `.tsx`, `.mts` and `.jsx` load as written; transpiling never type-checks, so run
  `npx tsc -p .`.
- Panels and frame scripts import only `orca`, `orca/*` and relative files (`./todos` finds
  `todos.tsx`, `todos.ts`, then `todos/index.*`). A bare package such as `react` fails: copy its
  ESM files in, or bundle with `--external:orca --external:'orca/*'` (example `hello-components`).
- A worker `main` is `.js`, `.mjs`, `.ts` or `.mts`. Bare imports resolve as Node does, but do not
  commit `node_modules/`; bundle npm dependencies. `orca/worker` is types only: `import type`.

## The loop

1. `ORCA plugin create ./my-plugin --template components --json`. Leave out `--publisher`.
2. In a background terminal, run `ORCA plugin dev watch ./my-plugin --check --shot
   ./my-plugin/.orca/shots --json` and keep reading it (events in `references/workflow.md`).
   Consent exits `3`: see [Approval](#approval).
3. Edit and save. Each save prints `reloaded`, a `check` of what each panel drew or threw, and a
   `shot` whose `path` is a PNG of the panel exactly as Orca draws it: read the image and fix
   what looks wrong. Fix every `log` error (`[frame] <file>:<line>`) and `check` issue. To see a
   state behind input, `ORCA plugin shot <plugin-key> --act '<json>'` types and presses first.
4. `ORCA plugin test <dir> --json` after changes, and `ORCA plugin check <dir> --json` before you
   finish (it runs the worker; add states in `src/panel.check.ts`, see `references/workflow.md`).
   For a worker, `ORCA plugin dev emit . <event> --data '{...}'` fires a test event and
   `ORCA plugin dev request . <name> --data '{...}'` calls an `orca.panels.handle` handler.
5. To show the user, `ORCA plugin open <plugin-key> --panel <id>`. Ctrl-C stops the watch.

## Ship

1. `ORCA plugin validate <dir> --json` until it exits `0`, and show the user
   `ORCA plugin inspect <dir> --json`: what it contributes and the access it asks for.
2. Publish only when the user asks; it is public and uses their GitHub identity. Commit and push to
   the repository that will own it, set `version`, tag `v<version>`, add the `orca-plugin` topic,
   and for a catalog paste what `ORCA plugin release-entry <dir> --json` prints. The Git and `gh`
   steps: `ORCA skills get orca-cli --reference references/plugins.md`.

## Approval

Content-only plugins (themes, icons, syntaxes, language packs) load without approval. Anything
that runs code or acts in Orca fails with `approval_required` (exit `3`); `error.data` lists what it
would be granted and the command with `--approve <fingerprint>`. Approving grants real access on
the user's machine: show them that list, and re-run with `--approve` only when they asked for
exactly this plugin and this access. Never approve on their behalf otherwise, and never pass a
fingerprint Orca did not give you. New capabilities or changed commands print a new approval.
`plugin_system_disabled`: ask the user to click "Turn on plugins" in Settings → Plugins.

## Gotchas

- `engines.orca` must cover the newest `Since` you use (`references/manifest.md`); components,
  build-less entries and leaving out `publisher` need `>=1.4.246`. Ids starting `orca-` are reserved.
- `update(atom, fn)` takes an updater only; `set(atom, value)` stores a value. Both throw while
  rendering. Components panels have no hooks and no DOM: state lives in atoms.
- Keyed atoms (`atom('draft', '')`) survive a hot reload; unkeyed ones and module variables reset.
  `persist` values must be plain JSON; bump `version` (with `migrate`) when the shape changes.
- Never poll for the time: `<RelativeTime at={ms} />` and `{ type: 'relative', at }` cells tick.
- A save that fails to load keeps the last good render with an inline `file:line:col` error.
- No network: requests outside the plugin's files fail. Ship assets and load them relatively.
- `shell.openExternal` and `files.saveAs` need a press on a settled control; never call on load.
- A worker's `main` must `export default function activate(orca)`.
- A worker save restarts the worker and drops its in-memory state; keep counters and caches you need across saves in `orca.storage`.
- A plugin holds at most 2,000 files and 50 MiB; each transpiled file 1 MiB.

## Conditional references

Run `ORCA skills get orca-plugin-authoring --reference references/<file>.md` and read only what you
need (`--references` lists them; `--full` if `--reference` is rejected).

| Read when                                                            | Reference                  |
| -------------------------------------------------------------------- | -------------------------- |
| Reading `dev watch` events; shots, `open`, `dev emit`; test examples | `references/workflow.md`   |
| The full test kit: `mount`, `mountWorker`, `mockHost`, every act     | `references/testing.md`    |
| A panel with its own worker, storage, settings; agent status; events | `references/recipes.md`    |
| Writing a components panel: components, props, atoms, `host`         | `references/components.md` |
| Calling the host from a worker, frame or panel; capabilities         | `references/host-api.md`   |
| Subscribing to worker, frame or panel events and their payloads      | `references/events.md`     |
| Writing or fixing `orca-plugin.json`, choosing `engines.orca`        | `references/manifest.md`   |
| Running any `ORCA plugin` command you have not used in this task     | `references/cli.md`        |
