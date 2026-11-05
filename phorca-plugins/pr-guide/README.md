# PR Guide for Phorca

Create a chaptered local guide with the PR's real code diff using your existing `gh` and Claude Code sign-ins. The plugin works across repositories on Phorca for Windows and macOS. It does not create, prune, or remove worktrees or change Phorca source. It posts to GitHub only when you send a comment with **GitHub PR** selected.

PR Guide owns the chaptering prompt, guide validation, React viewer, diff display, and comment controls. The viewer has thematic chapters, reviewed checkboxes, one file at a time with compact file navigation, and lightweight code highlighting. Expand **About this PR** or **Chapter overview** when you need that context. PR fetching, refresh, and GitHub comment posting also live in this standalone plugin.

The viewer and Orca process-host wrapper are bundled with the plugin. It has no Plannotator package, asset service, or cache dependency. Installing and running the plugin needs no npm, Bun, or build step on Windows or macOS.

The viewer and comment form are React components in `guide-ui.jsx` and `comment-ui.jsx`. In a Phorca source checkout, run `npm install --no-package-lock && npm run build` after editing them; the build also refreshes the bundled process-host wrapper. Phorca does not need React or npm installed at runtime.

## Install

1. Install Phorca 1.4.224 or newer, Git, [GitHub CLI](https://cli.github.com/) (`gh auth login`), and [Claude Code](https://docs.anthropic.com/en/docs/claude-code/setup) (`claude auth login`). On Windows, use the native `claude.exe` installer. You need access to the Phorca repository.
2. In PowerShell or a macOS terminal, download only the plugin folder:

   ```sh
   git clone --filter=blob:none --sparse --depth 1 https://github.com/phocassoftware/phorca.git phorca-pr-guide
   git -C phorca-pr-guide sparse-checkout set phorca-plugins/pr-guide
   ```

   Until [PR #30](https://github.com/phocassoftware/phorca/pull/30) merges, add `--branch lfa9603/pr-guide-plugin-module` to the `git clone` command.
3. In Phorca, open **Settings → Plugins**, enable plugins, and choose **Install plugin → Local folder**. Enter the absolute path to `phorca-pr-guide/phorca-plugins/pr-guide` and approve **notifications**, **storage**, **workspace read**, and **terminal send**. Phorca copies the checked-in bundle and refreshes the plugin. The **Git URL** tab expects `orca-plugin.json` at the repository root, so it cannot install this subfolder directly.

To update later, run `git -C phorca-pr-guide pull --ff-only`, then install the same local folder again in Phorca and approve any changed permissions. No worktree is created or pruned by the plugin.

## Create a guide

1. Copy a URL such as `https://github.com/phocassoftware/fs-app/pull/2640` to the clipboard.
2. In Phorca's command palette, run **PR Guide: Create from clipboard**.
3. The plugin opens its PR Guide page with thematic chapters, file summaries, the PR diff, and comment controls in an integrated Phorca browser tab in the active worktree. If Phorca cannot create the tab, it opens the system browser. Phorca also shows the local URL in a notification.

Click the **+** beside a diff line to open an inline comment form for that line. Choose **GitHub PR** to post a PR review comment, or **Local agent session** to queue the feedback in a selected writable agent terminal in the PR worktree. The local option lists sessions in the guide's associated worktree, or in the active worktree when it belongs to the same repository. Use the target menu for a chapter or whole-PR comment. The page checks the PR before sending. It checks the PR title, body, head, and base every minute and regenerates the guide when they change. Unpushed local changes are ignored. A draft comment is kept if the PR updates; reload after copying the draft to review the new diff.

If a GitHub send reports an error, check the PR before retrying. GitHub may have accepted the comment before the local command reported failure.

If the command cannot start, Phorca shows the cause in a notification. For worker startup errors, open **Settings → Plugins → Installed → PR Guide → More actions → View logs**.

The palette command creates a guide without a worktree or session association. Use the session command below when you need that association.

## Create a guide from the current agent session

Run this from a terminal in the Orca-managed worktree, using the plugin folder's absolute path:

```sh
node /path/to/pr-guide/session-guide.mjs https://github.com/owner/repo/pull/123
```

The command uses `CODEX_SESSION_ID` (or `CLAUDE_SESSION_ID`) to record the current session. If neither is available, pass the session ID as a second argument. It checks that the PR belongs to the current worktree's repository, saves the guide with the session ID and exact worktree identity, and links the PR to the worktree in Orca. It refuses to replace an existing link to a different PR. It opens the viewer in a Phorca browser tab when possible. Keep this command running while commenting. The guide never writes inside the worktree.

Guides are saved under `%LOCALAPPDATA%\Phorca PR Guide\guides` on Windows or `~/Library/Application Support/Phorca PR Guide/guides` on macOS. Each run writes a Markdown file and a JSON snapshot containing the guide and PR patch. The PR body and patch are sent to the local Claude Code CLI for generation; the body is not saved. PR changes produce new snapshots. The viewer listens only on `127.0.0.1` with a random URL; closing Phorca or the session command stops its local server.

To reopen a saved snapshot without regenerating it, run `node /path/to/pr-guide/viewer.mjs /path/to/guide.json`, then open the printed local URL. Keep that process running while commenting. It still refreshes from the GitHub PR when the remote head changes. This standalone viewer supports GitHub comments; local agent comments require a guide opened by the Phorca action or session command.

Guide generation uses Claude Sonnet at medium effort and accepts up to 250 changed files and a 600 KB patch. It checks GitHub's total file count before downloading the diff and gets the complete filename list from the paginated files API. Larger PRs return a clear error rather than a partial guide. For example, phorca PR #24 changes 16,928 files and needs to be split before a complete guide can be generated. On macOS, `gh` and `claude` must be on Phorca's `PATH`. On Windows, `gh.exe` must be on `PATH`; the plugin accepts a `claude.exe` on `PATH` or a standard WinGet `claude.cmd` shim pointing to the native executable.

The current Phorca plugin API does not let a sidebar panel invoke the guide worker or load generated guide data, so the interactive guide opens as a local browser page. The palette command reads the PR URL from the clipboard because palette commands receive no arguments.
