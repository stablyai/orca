<h1 align="center">

  <a href="https://onOrca.dev"><img src="../resources/build/icon.png" alt="Orca" width="64" valign="middle" /></a> Orca

</h1>

<p align="center">

  <img src="https://img.shields.io/badge/Platform-macOS%20%7C%20Windows%20%7C%20Linux-blue?style=for-the-badge" alt="支持的平台" />

  <a href="https://discord.gg/fzjDKHxv8Q"><img src="https://img.shields.io/badge/Discord-Join-5865F2?style=for-the-badge&logo=discord&logoColor=white" alt="Discord" /></a>

  <a href="https://x.com/orca_build"><img src="https://img.shields.io/badge/%E2%80%8E-Follow_@orca__build-000000?style=for-the-badge&logo=x&logoColor=white" alt="在 X 上关注" /></a>

</p>

<p align="center">

  <a href="../README.md">English</a> · <a href="README.zh-CN.md">中文</a> · <a href="README.ja.md">日本語</a> · <a href="README.es.md">Español</a>

</p>

<p align="center">

  <strong>面向 100x 构建者的 AI 编排器。</strong><br/>

  跨仓库并排运行 Claude Code、Codex 或 OpenCode — 每个都在自己的 worktree 中运行，并在一个地方统一跟踪。<br/>

  支持 <strong>macOS、Windows 和 Linux</strong>。

</p>

<p align="center">

  <a href="#安装"><strong>下载 🐋</strong></a>

</p>

<p align="center">

  <img src="assets/file-drag.gif" alt="Orca Screenshot" width="800" />

</p>

## 支持的智能体

Orca 支持任何 CLI 智能体（*不仅限于以下列表*）。

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

## 特性

- **无需登录** — 直接使用你自己的 Claude Code 或 Codex 订阅。
- **原生 worktree 工作流** — 每个功能都有自己的 worktree。无需 stash，也不用来回切分支。立即创建，快速切换。
- **多智能体终端** — 在标签页和面板中并排运行多个 AI 智能体。一眼就能看到哪些正在活跃。
- **内置源码管理** — 查看 AI 生成的 diff，快速编辑，并且无需离开 Orca 就能提交。
- **GitHub 集成** — PR、issue 和 Actions 检查会自动链接到对应的 worktree。
- **SSH 支持** — 连接远程机器，并直接从 Orca 在远程机器上运行智能体。
- **通知** — 智能体完成任务或需要关注时及时通知你。可将会话标记为未读，方便稍后返回处理。

---

## 安装

### Mac, Linux, Windows

- **[从 onOrca.dev 下载](https://onOrca.dev)**
- 或通过 **[GitHub Releases 页面](https://github.com/stablyai/orca/releases/latest)** 获取

*也可以通过包管理器安装：*

### macOS (Homebrew)

```bash
brew install --cask stablyai/orca/orca
```

### Arch Linux (AUR)

```bash
# 预编译二进制
yay -S stably-orca-bin

# 从 GitHub 源码构建
yay -S stably-orca-git
```

---

## [全新] 标注 AI Diff

**直接在 AI 生成的 diff 上评论。**

在 AI 生成的 diff 的任意一行添加你的反馈，然后发回给智能体进行修改。让评审循环保持紧凑 — 无需复制行号，也无需切换上下文。

<p align="center">

  <img src="assets/annotate-ai-diff.gif" alt="Orca 标注 AI Diff — 在 AI 生成的 diff 上评论并将反馈发送给智能体" width="800" />

</p>

---

## [全新] Codex 账号热切换

**有多个 Codex 账号？一键切换。**

如果你使用多个 Codex 账号来获得更合适的 token 配额，Orca 可让你在它们之间即时热切换 — 无需重新登录，也无需修改配置文件。选中账号，然后继续构建。

<p align="center">

  <img src="assets/codex-account-switcher.gif" alt="Orca Codex 账号切换器 — 在多个 Codex 账号之间热切换" width="800" />

</p>

---

## [全新] 每个 worktree 的浏览器和设计模式

**查看你的应用。点击任意元素。直接放入聊天。**

Orca 在你的 worktree 中内置了浏览器。边构建边预览应用，然后切换到设计模式 — 点击任意 UI 元素，它会作为上下文直接进入你的 AI 聊天。无需截图，无需复制选择器。只需指向想修改的地方，然后告诉智能体要做什么。

<p align="center">

  <img src="assets/orca-design-mode.gif" alt="Orca 设计模式 — 点击任意 UI 元素并放入聊天" width="800" />

</p>

---

## [全新] Orca CLI 介绍

**从终端编排智能体。**

让你的 AI 智能体控制 IDE。使用 AI 将项目添加到 IDE、创建 worktree，并直接从终端更新当前 worktree 的评论，留下有意义的进度检查点。Orca IDE 随附此功能（在设置中安装）。

```bash
npx skills add https://github.com/stablyai/orca --skill orca-cli
```

---

## 社区与支持

- **Discord:** 加入我们的 **[Discord](https://discord.gg/fzjDKHxv8Q)** 社区。
- **Twitter / X:** 关注 **[@orca_build](https://x.com/orca_build)** 获取更新和公告。
- **反馈与想法:** 我们发布很快。缺少什么功能？[提交功能请求](https://github.com/stablyai/orca/issues)。
- **支持我们:** 给这个仓库点 Star，关注我们的日常发布。

---

## 开发

想要贡献代码或在本地运行？请参阅我们的 [CONTRIBUTING.md](../CONTRIBUTING.md) 指南。
