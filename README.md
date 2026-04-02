<p align="center">
  <img src="build/icon.png" alt="Orca" width="128" />
</p>


<h1 align="center">Orca</h1>

<strong>A cross-platform AI Orchestrator for 100x engineers.</strong><br/>
Seamlessly manage multiple worktrees and open multiple terminals running anything — Claude Code, Codex, OpenCode, and more.<br/>
Built-in status tracking, notifications, and unread markers. Makes coding multiple features across multiple repos a breeze.

Learn more at <a align="center" href="https://onOrca.dev">onOrca.dev</a>

<p align="center">
  <img src="file-drag.gif" alt="Orca Screenshot" width="800" />
</p>

---

### Shipping daily

Missing something? It's probably landing tomorrow. **[Request a feature](https://github.com/stablyai/orca/issues)** · **Star** to follow along.

---

## Features
  * Manage multiple worktrees
  * Multiple terminals, tabs and panes
  * Get worktree notifications (plus ability to manually mark threads as unread -- similar to Gmail ⭐)
  * See which worktrees have working agents
  * GitHub integrations for GH PRs (automatic), ability to link GH issues (via `gh` cli), and a GH checks viewer
  * File editor, search, source control tab (see worktree changes, make edits, easily commit)

## Install
Grab a release from https://onOrca.dev or download from the GH release page

## Developing

See [CONTRIBUTING.md](CONTRIBUTING.md) for branch naming, PR expectations, and required checks.

### Install

```bash
$ pnpm install
```

### Development

```bash
$ pnpm dev
```

### Build

```bash
# For windows
$ pnpm build:win

# For macOS
$ pnpm build:mac

# For Linux
$ pnpm build:linux
```
