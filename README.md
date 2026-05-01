<h1 align="center">

  <a href="https://onOrca.dev"><img src="resources/build/icon.png" alt="Orca" width="64" valign="middle" /></a> Orca

</h1>

<p align="center">

  <img src="https://img.shields.io/badge/Platform-macOS%20%7C%20Windows%20%7C%20Linux-blue?style=for-the-badge" alt="Supported Platforms" />

  <a href="https://discord.gg/fzjDKHxv8Q"><img src="https://img.shields.io/badge/Discord-Join-5865F2?style=for-the-badge&logo=discord&logoColor=white" alt="Discord" /></a>

  <a href="https://x.com/orca_build"><img src="https://img.shields.io/badge/%E2%80%8E-Follow_@orca__build-000000?style=for-the-badge&logo=x&logoColor=white" alt="Follow on X" /></a>

</p>

<p align="center">

  <a href="README.md">English</a> · <a href="docs/README.zh-CN.md">中文</a> · <a href="docs/README.ja.md">日本語</a> · <a href="docs/README.es.md">Español</a>

</p>

<p align="center">

  <strong>The AI Orchestrator for 100x builders.</strong><br/>

  Run Claude Code, Codex, or OpenCode side-by-side across repos — each in its own worktree, tracked in one place.<br/>

  Available for <strong>macOS, Windows, and Linux</strong>.

</p>

<p align="center">

  <a href="#install"><strong>Download 🐋</strong></a>

</p>

<p align="center">

  <img src="docs/assets/file-drag.gif" alt="Orca Screenshot" width="800" />

</p>

## Supported Agents

Orca supports any CLI agent (*not just this list*).

<p>

  <a href="https://docs.anthropic.com/claude/docs/claude-code"><kbd><img src="https://www.google.com/s2/favicons?domain=anthropic.com&sz=64" width="16" valign="middle" /> Claude Code</kbd></a> &nbsp;

  <a href="https://github.com/openai/codex"><kbd><img src="https://www.google.com/s2/favicons?domain=openai.com&sz=64" width="16" valign="middle" /> Codex</kbd></a> &nbsp;

  <a href="https://github.com/google-gemini/gemini-cli"><kbd><img src="https://www.google.com/s2/favicons?domain=gemini.google.com&sz=64" width="16" valign="middle" /> Gemini</kbd></a> &nbsp;

  <a href="https://pi.dev"><kbd><img src="https://pi.dev/favicon.svg" width="16" valign="middle" /> Pi</kbd></a> &nbsp;

  <a href="https://hermes-agent.nousresearch.com/docs/"><kbd><img src="https://www.google.com/s2/favicons?domain=nousresearch.com&sz=64" width="16" valign="middle" /> Hermes Agent</kbd></a> &nbsp;

  <a href="https://opencode.ai/docs/cli/"><kbd><img src="https://www.google.com/s2/favicons?domain=opencode.ai&sz=64" width="16" valign="middle" /> OpenCode</kbd></a> &nbsp;

  <a href="https://block.github.io/goose/docs/quickstart/"><kbd><img src="https://www.google.com/s2/favicons?domain=goose-docs.ai&sz=64" width="16" valign="middle" /> Goose</kbd></a> &nbsp;

  <a href="https://ampcode.com/manual#install"><kbd><img src="https://www.google.com/s2/favicons?domain=ampcode.com&sz=64" width="16" valign="middle" /> Amp</kbd></a> &nbsp;

  <a href="https://docs.augmentcode.com/cli/overview"><kbd><img src="https://www.google.com/s2/favicons?domain=augmentcode.com&sz=64" width="16" valign="middle" /> Auggie</kbd></a> &nbsp;

  <a href="https://github.com/charmbracelet/crush"><kbd><img src="https://www.google.com/s2/favicons?domain=charm.sh&sz=64" width="16" valign="middle" /> Charm</kbd></a> &nbsp;

  <a href="https://docs.cline.bot/cline-cli/overview"><kbd><img src="https://www.google.com/s2/favicons?domain=cline.bot&sz=64" width="16" valign="middle" /> Cline</kbd></a> &nbsp;

  <a href="https://www.codebuff.com/docs/help/quick-start"><kbd><img src="https://www.google.com/s2/favicons?domain=codebuff.com&sz=64" width="16" valign="middle" /> Codebuff</kbd></a> &nbsp;

  <a href="https://docs.continue.dev/guides/cli"><kbd><img src="https://www.google.com/s2/favicons?domain=continue.dev&sz=64" width="16" valign="middle" /> Continue</kbd></a> &nbsp;

  <a href="https://cursor.com/cli"><kbd><img src="https://www.google.com/s2/favicons?domain=cursor.com&sz=64" width="16" valign="middle" /> Cursor</kbd></a> &nbsp;

  <a href="https://docs.factory.ai/cli/getting-started/quickstart"><kbd><img src="https://www.google.com/s2/favicons?domain=factory.ai&sz=64" width="16" valign="middle" /> Droid</kbd></a> &nbsp;

  <a href="https://docs.github.com/en/copilot/how-tos/set-up/install-copilot-cli"><kbd><img src="https://www.google.com/s2/favicons?domain=github.com&sz=64" width="16" valign="middle" /> GitHub Copilot</kbd></a> &nbsp;

  <a href="https://kilo.ai/docs/cli"><kbd><img src="https://raw.githubusercontent.com/Kilo-Org/kilocode/main/packages/kilo-vscode/assets/icons/kilo-light.svg" width="16" valign="middle" /> Kilocode</kbd></a> &nbsp;

  <a href="https://www.kimi.com/code/docs/en/kimi-cli/guides/getting-started.html"><kbd><img src="https://www.google.com/s2/favicons?domain=moonshot.cn&sz=64" width="16" valign="middle" /> Kimi</kbd></a> &nbsp;

  <a href="https://kiro.dev/docs/cli/"><kbd><img src="https://www.google.com/s2/favicons?domain=kiro.dev&sz=64" width="16" valign="middle" /> Kiro</kbd></a> &nbsp;

  <a href="https://github.com/mistralai/mistral-vibe"><kbd><img src="https://www.google.com/s2/favicons?domain=mistral.ai&sz=64" width="16" valign="middle" /> Mistral Vibe</kbd></a> &nbsp;

  <a href="https://github.com/QwenLM/qwen-code"><kbd><img src="https://www.google.com/s2/favicons?domain=qwenlm.github.io&sz=64" width="16" valign="middle" /> Qwen Code</kbd></a> &nbsp;

  <a href="https://support.atlassian.com/rovo/docs/install-and-run-rovo-dev-cli-on-your-device/"><kbd><img src="https://www.google.com/s2/favicons?domain=atlassian.com&sz=64" width="16" valign="middle" /> Rovo Dev</kbd></a>

</p>

---

## Features

- **No login required** — Bring your own Claude Code or Codex subscription.
- **Worktree-native** — Every feature gets its own worktree. No stashing, no branch juggling. Spin up and switch instantly.
- **Multi-agent terminals** — Run multiple AI agents side-by-side in tabs and panes. See which ones are active at a glance.
- **Built-in source control** — Review AI-generated diffs, make quick edits, and commit without leaving Orca.
- **GitHub integration** — PRs, issues, and Actions checks linked to each worktree automatically.
- **SSH support** — Connect to remote machines and run agents on them directly from Orca.
- **Notifications** — Know when an agent finishes or needs attention. Mark threads unread to come back later.

---

## Install

### Mac, Linux, Windows

- **[Download from onOrca.dev](https://onOrca.dev)**
- Or via **[GitHub Releases page](https://github.com/stablyai/orca/releases/latest)**

*Alternatively, install from a package manager:*

### macOS (Homebrew)

```bash
brew install --cask stablyai/orca/orca
```

### Arch Linux (AUR)

```bash
# Precompiled binary
yay -S stably-orca-bin

# Build from GitHub source
yay -S stably-orca-git
```

---

## [New] Annotate AI Diff

**Comment directly on AI-generated diffs.**

Annotate any line in an AI-generated diff with your feedback, then send it back to the agent to revise. Keep the review loop tight — no copying line numbers, no context switching.

<p align="center">

  <img src="docs/assets/annotate-ai-diff.gif" alt="Orca Annotate AI Diff — comment on AI-generated diffs and send feedback to the agent" width="800" />

</p>

---

## [New] Hot Swap Codex Accounts

**Multiple Codex accounts? Switch in one click.**

If you run multiple Codex accounts to get the best token deal, Orca lets you hot-swap between them instantly — no re-login, no config files. Just pick an account and keep building.

<p align="center">

  <img src="docs/assets/codex-account-switcher.gif" alt="Orca Codex Account Switcher — hot swap between multiple Codex accounts" width="800" />

</p>

---

## [New] Per Worktree Browser &amp; Design Mode

**See your app. Click any element. Drop it into the chat.**

Orca ships with a built-in browser right inside your worktree. Preview your app as you build, then switch to Design Mode — click any UI element and it lands directly in your AI chat as context. No screenshots, no copy-pasting selectors. Just point at what you want to change and tell the agent what to do.

<p align="center">

  <img src="docs/assets/orca-design-mode.gif" alt="Orca Design Mode — click any UI element and drop it into the chat" width="800" />

</p>

---

## [New] Introducing the Orca CLI

**Agent orchestration from your terminal.**

Let your AI agent control your IDE. Use AI to add projects to your IDE, spin up worktrees, and update the current worktree's comment with meaningful progress checkpoints directly from the terminal. Ships with the Orca IDE (install under Settings).

```bash
npx skills add https://github.com/stablyai/orca --skill orca-cli
```

---

## Community &amp; Support

- **Discord:** Join the community on **[Discord](https://discord.gg/fzjDKHxv8Q)**.
- **Twitter / X:** Follow **[@orca_build](https://x.com/orca_build)** for updates and announcements.
- **Feedback &amp; Ideas:** We ship fast. Missing something? [Request a new feature](https://github.com/stablyai/orca/issues).
- **Show Support:** Star this repo to follow along with our daily ships.

---

## Developing

Want to contribute or run locally? See our [CONTRIBUTING.md](CONTRIBUTING.md) guide.
