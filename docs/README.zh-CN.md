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
  <a href="https://docs.anthropic.com/claude/docs/claude-code"><kbd><img src="assets/claude-logo.svg" width="16" valign="middle" /> Claude Code</kbd></a> &nbsp;
  <a href="https://github.com/openai/codex"><kbd><img src="https://www.google.com/s2/favicons?domain=openai.com&sz=64" width="16" valign="middle" /> Codex</kbd></a> &nbsp;
  <a href="https://github.com/google-gemini/gemini-cli"><kbd><img src="https://www.google.com/s2/favicons?domain=gemini.google.com&sz=64" width="16" valign="middle" /> Gemini</kbd></a> &nbsp;
  <a href="https://pi.dev"><kbd><img src="https://pi.dev/favicon.svg" width="16" valign="middle" /> Pi</kbd></a> &nbsp;
  <a href="https://hermes-agent.nousresearch.com/docs/"><kbd><img src="https://www.google.com/s2/favicons?domain=nousresearch.com&sz=64" width="16" valign="middle" /> Hermes Agent</kbd></a> &nbsp;
  <a href="https://opencode.ai/docs/cli/"><kbd><img src="https://www.google.com/s2/favicons?domain=opencode.ai&sz=64" width="16" valign="middle" /> OpenCode</kbd></a> &nbsp;
  <a href="https://block.github.io/goose/docs/quickstart/"><kbd><img src="https://www.google.com/s2/favicons?domain=goose-docs.ai&sz=64" width="16" valign="middle" /> Goose</kbd></a> &nbsp;
  <a href="https://ampcode.com/manual#install"><kbd><img src="https://www.google.com/s2/favicons?domain=ampcode.com&sz=64" width="16" valign="middle" /> Amp</kbd></a> &nbsp;
  <a href="https://docs.augmentcode.com/cli/overview"><kbd><img src="https://www.google.com/s2/favicons?domain=augmentcode.com&sz=64" width="16" valign="middle" /> Auggie</kbd></a> &nbsp;
  <a href="https://github.com/autohandai/code-cli"><kbd><img src="https://www.google.com/s2/favicons?domain=autohand.ai&sz=64" width="16" valign="middle" /> Autohand Code</kbd></a> &nbsp;
  <a href="https://github.com/charmbracelet/crush"><kbd><img src="https://www.google.com/s2/favicons?domain=charm.sh&sz=64" width="16" valign="middle" /> Charm</kbd></a> &nbsp;
  <a href="https://docs.cline.bot/cline-cli/overview"><kbd><img src="https://www.google.com/s2/favicons?domain=cline.bot&sz=64" width="16" valign="middle" /> Cline</kbd></a> &nbsp;
  <a href="https://www.codebuff.com/docs/help/quick-start"><kbd><img src="https://www.google.com/s2/favicons?domain=codebuff.com&sz=64" width="16" valign="middle" /> Codebuff</kbd></a> &nbsp;
  <a href="https://docs.continue.dev/guides/cli"><kbd><img src="https://www.google.com/s2/favicons?domain=continue.dev&sz=64" width="16" valign="middle" /> Continue</kbd></a> &nbsp;
  <a href="https://cursor.com/cli"><kbd><img src="https://www.google.com/s2/favicons?domain=cursor.com&sz=64" width="16" valign="middle" /> Cursor</kbd></a> &nbsp;
  <a href="https://docs.factory.ai/cli/getting-started/quickstart"><kbd><img src="assets/droid-logo.svg" width="16" valign="middle" /> Droid</kbd></a> &nbsp;
  <a href="https://docs.github.com/en/copilot/how-tos/set-up/install-copilot-cli"><kbd><img src="https://www.google.com/s2/favicons?domain=github.com&sz=64" width="16" valign="middle" /> GitHub Copilot</kbd></a> &nbsp;
  <a href="https://kilo.ai/docs/cli"><kbd><img src="https://raw.githubusercontent.com/Kilo-Org/kilocode/main/packages/kilo-vscode/assets/icons/kilo-light.svg" width="16" valign="middle" /> Kilocode</kbd></a> &nbsp;
  <a href="https://www.kimi.com/code/docs/en/kimi-code-cli/getting-started.html"><kbd><img src="https://www.google.com/s2/favicons?domain=moonshot.cn&sz=64" width="16" valign="middle" /> Kimi</kbd></a> &nbsp;
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

## 移动 Companion

用手机查看智能体状态和用量。

<p align="center">
  <picture><source srcset="assets/feature-wall/mobile-companion-showcase.gif" type="image/gif"><img src="assets/feature-wall/mobile-companion-showcase.jpg" alt="Orca 桌面端与移动 companion 应用" width="720" /></picture>
</p>

- **iOS:** [从 App Store 下载 Orca IDE](https://apps.apple.com/us/app/orca-ide/id6766130217)
- **Android:** [从 GitHub Releases 下载 APK](https://github.com/stablyai/orca/releases)

---

## 功能展示

点击任意卡片了解对应工作流。

<p align="center">
  <a href="https://www.onorca.dev/docs/model/worktrees"><kbd><strong>并行 Worktree</strong><br/><br/><picture><source srcset="assets/feature-wall/parallel-worktrees.gif" type="image/gif"><img src="assets/feature-wall/parallel-worktrees.jpg" alt="并行 worktree 编排" width="390" /></picture><br/></kbd></a> &nbsp;&nbsp;
  <a href="https://www.onorca.dev/docs/terminal"><kbd><strong>终端分屏</strong><br/><br/><picture><source srcset="assets/feature-wall/terminal-splits.gif" type="image/gif"><img src="assets/feature-wall/terminal-splits.jpg" alt="Ghostty 级终端分屏" width="390" /></picture><br/></kbd></a><br/><br/>
  <a href="https://www.onorca.dev/docs/browser/design-mode"><kbd><strong>设计模式</strong><br/><br/><picture><source srcset="assets/feature-wall/design-mode.gif" type="image/gif"><img src="assets/feature-wall/design-mode.jpg" alt="内置浏览器与设计模式" width="390" /></picture><br/></kbd></a> &nbsp;&nbsp;
  <a href="https://www.onorca.dev/docs/review/linear"><kbd><strong>GitHub 与 Linear 原生集成</strong><br/><br/><picture><source srcset="assets/feature-wall/github-linear.gif" type="image/gif"><img src="assets/feature-wall/github-linear.jpg" alt="Orca 中的 GitHub 与 Linear 工作流" width="390" /></picture><br/></kbd></a><br/><br/>
  <a href="https://www.onorca.dev/docs/agents/supported"><kbd><strong>任意 CLI 智能体</strong><br/><br/><picture><source srcset="assets/feature-wall/cli-agents.gif" type="image/gif"><img src="assets/feature-wall/cli-agents.jpg" alt="支持任意 CLI 智能体" width="390" /></picture><br/></kbd></a> &nbsp;&nbsp;
  <a href="https://www.onorca.dev/docs/ssh"><kbd><strong>SSH Worktree</strong><br/><br/><picture><source srcset="assets/feature-wall/ssh-worktrees.gif" type="image/gif"><img src="assets/feature-wall/ssh-worktrees.jpg" alt="通过 SSH 使用远程 worktree" width="390" /></picture><br/></kbd></a><br/><br/>
  <a href="https://www.onorca.dev/docs/editing/file-explorer"><kbd><strong>拖文件给智能体</strong><br/><br/><picture><source srcset="assets/feature-wall/file-drag.gif" type="image/gif"><img src="assets/feature-wall/file-drag.jpg" alt="将文件和图片拖入智能体提示" width="390" /></picture><br/></kbd></a> &nbsp;&nbsp;
  <a href="https://www.onorca.dev/docs/review/annotate-ai-diff"><kbd><strong>标注 AI Diff</strong><br/><br/><picture><source srcset="assets/feature-wall/annotate-diff.gif" type="image/gif"><img src="assets/feature-wall/annotate-diff.jpg" alt="标注 AI 生成的 diff" width="390" /></picture><br/></kbd></a><br/><br/>
  <a href="https://www.onorca.dev/docs/cli/overview"><kbd><strong>Orca CLI</strong><br/><br/><picture><source srcset="assets/feature-wall/orca-cli.gif" type="image/gif"><img src="assets/feature-wall/orca-cli.jpg" alt="从 CLI 脚本化 Orca" width="390" /></picture><br/></kbd></a> &nbsp;&nbsp;
  <a href="https://www.onorca.dev/docs/settings"><kbd><strong>原生搜索</strong><br/><br/><picture><source srcset="assets/feature-wall/keyboard-native.gif" type="image/gif"><img src="assets/feature-wall/keyboard-native.jpg" alt="贯穿 Orca 工作流的原生搜索" width="390" /></picture><br/></kbd></a><br/><br/>
  <a href="https://www.onorca.dev/docs/agents/usage-tracking"><kbd><strong>账号切换与用量追踪</strong><br/><br/><picture><source srcset="assets/feature-wall/codex-accounts.gif" type="image/gif"><img src="assets/feature-wall/codex-accounts.jpg" alt="账号切换与用量追踪" width="390" /></picture><br/></kbd></a> &nbsp;&nbsp;
  <a href="https://www.onorca.dev/docs/editing/markdown"><kbd><strong>丰富仓库预览</strong><br/><br/><picture><source srcset="assets/feature-wall/markdown-editor.gif" type="image/gif"><img src="assets/feature-wall/markdown-editor.jpg" alt="Markdown、图片、PDF 和仓库文档预览" width="390" /></picture><br/></kbd></a><br/><br/>
  <a href="https://www.onorca.dev/docs/model/tabs-panes-splits"><kbd><strong>任意分屏</strong><br/><br/><picture><source srcset="assets/feature-wall/split-screen.gif" type="image/gif"><img src="assets/feature-wall/split-screen.jpg" alt="为智能体、终端、浏览器和文件分屏" width="390" /></picture><br/></kbd></a>
</p>

---

## 社区与支持

- **Discord:** 加入我们的 **[Discord](https://discord.gg/fzjDKHxv8Q)** 社区。
- **Twitter / X:** 关注 **[@orca_build](https://x.com/orca_build)** 获取更新和公告。
- **反馈与想法:** 我们发布很快。缺少什么功能？[提交功能请求](https://github.com/stablyai/orca/issues)。
- **支持我们:** 给这个仓库点 Star，关注我们的日常发布。

---

## 开发

想要贡献代码或在本地运行？请参阅我们的 [CONTRIBUTING.md](../.github/CONTRIBUTING.md) 指南。
