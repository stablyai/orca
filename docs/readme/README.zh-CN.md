<h1 align="center">
  <a href="https://onOrca.dev"><img src="../../resources/build/icon.png" alt="Orca" width="64" valign="middle" /></a> Orca
</h1>

<p align="center">
  <a href="https://github.com/stablyai/orca/stargazers"><img src="https://badgen.net/github/stars/stablyai/orca?label=%E2%98%85" alt="GitHub Star 数" /></a>
  <a href="https://github.com/stablyai/orca/releases"><img src="../assets/readme-downloads.svg" alt="所有版本的总下载量" /></a>
  <img src="https://badgen.net/github/license/stablyai/orca" alt="许可证" />
  <a href="https://discord.gg/fzjDKHxv8Q"><img src="https://img.shields.io/badge/Discord-5865F2?logo=discord&logoColor=white" alt="加入 Orca Discord" /></a>
  <a href="https://x.com/orca_build"><img src="https://img.shields.io/badge/X-000000?logo=x&logoColor=white" alt="在 X 上关注 Orca" /></a>
  <img src="https://img.shields.io/badge/macOS%20%7C%20Windows%20%7C%20Linux-4493F8?style=flat-square" alt="支持的平台：macOS、Windows 和 Linux" />
</p>

<p align="center">
  <sub><a href="../../README.md">English</a> · <a href="README.es.md">Español</a> · <a href="README.pt.md">Português</a> · <a href="README.ja.md">日本語</a> · <a href="README.ko.md">한국어</a></sub>
</p>

<p align="center">
  <strong>面向 100x 构建者的 AI 编排器。</strong><br/>
  并排运行 Codex、Claude Code、OpenCode 或 Pi — 每个都在自己的 worktree 中运行，并在一个地方统一跟踪。
</p>

<h3 align="center"><a href="https://onorca.dev/download"><ins>下载 Orca</ins></a></h3>

<p align="center">
  <img src="../assets/readme-hero.jpg" alt="Orca 桌面应用在并行 worktree 中运行智能体，角落里是 Orca 移动 companion 应用" width="960" />
</p>

## 特性

<table>
<tr>
<td width="50%" valign="middle">

### 移动 Companion 应用

用手机监控并指挥你的智能体 — 智能体完成时收到通知，随时随地发送后续指令。

[iOS App Store](https://apps.apple.com/us/app/orca-ide/id6766130217) · [Android APK](https://github.com/stablyai/orca/releases/download/mobile-android-v0.0.31/app-release.apk) · [文档 →](https://www.onorca.dev/docs/mobile)

</td>
<td width="50%">
  <a href="https://www.onorca.dev/docs/mobile"><picture><source srcset="../assets/feature-wall/mobile-companion-app-showcase.gif" type="image/gif"><img src="../assets/feature-wall/mobile-companion-app-showcase.jpg" alt="Orca 桌面端与移动 companion 应用" width="100%" /></picture></a>
</td>
</tr>
<tr>
<td width="50%" valign="middle">

### 并行 Worktree

把一个提示同时分发给五个智能体，每个都在自己隔离的 git worktree 中运行 — 比较结果，合并最佳方案。

[文档 →](https://www.onorca.dev/docs/model/worktrees)

</td>
<td width="50%">
  <a href="https://www.onorca.dev/docs/model/worktrees"><picture><source srcset="../assets/feature-wall/parallel-worktrees.gif" type="image/gif"><img src="../assets/feature-wall/parallel-worktrees.jpg" alt="并行 worktree 编排" width="100%" /></picture></a>
</td>
</tr>
<tr>
<td width="50%" valign="middle">

### 终端分屏

Ghostty 级终端，支持 WebGL 渲染、无限分屏，以及重启后依然保留的滚动历史。

[文档 →](https://www.onorca.dev/docs/terminal)

</td>
<td width="50%">
  <a href="https://www.onorca.dev/docs/terminal"><picture><source srcset="../assets/feature-wall/terminal-splits.gif" type="image/gif"><img src="../assets/feature-wall/terminal-splits.jpg" alt="终端分屏" width="100%" /></picture></a>
</td>
</tr>
<tr>
<td width="50%" valign="middle">

### 设计模式

在真实的 Chromium 窗口中点击任意 UI 元素，把它的 HTML、CSS 和裁剪好的截图直接发送到智能体的提示中。

[文档 →](https://www.onorca.dev/docs/browser/design-mode)

</td>
<td width="50%">
  <a href="https://www.onorca.dev/docs/browser/design-mode"><picture><source srcset="../assets/feature-wall/design-mode.gif" type="image/gif"><img src="../assets/feature-wall/design-mode.jpg" alt="内置浏览器与设计模式" width="100%" /></picture></a>
</td>
</tr>
<tr>
<td width="50%" valign="middle">

### GitHub &amp; Linear 原生集成

在应用内浏览 PR、issue 和项目看板 — 从任意任务打开 worktree，无需切换上下文即可完成评审。

[文档 →](https://www.onorca.dev/docs/review/linear)

</td>
<td width="50%">
  <a href="https://www.onorca.dev/docs/review/linear"><picture><source srcset="../assets/feature-wall/github-linear.gif" type="image/gif"><img src="../assets/feature-wall/github-linear.jpg" alt="Orca 中的 GitHub 与 Linear 任务工作流" width="100%" /></picture></a>
</td>
</tr>
<tr>
<td width="50%" valign="middle">

### SSH Worktree

在高性能远程机器上运行智能体，完整支持文件编辑、git 和终端 — 自动重连与端口转发一应俱全。

[文档 →](https://www.onorca.dev/docs/ssh)

</td>
<td width="50%">
  <a href="https://www.onorca.dev/docs/ssh"><picture><source srcset="../assets/feature-wall/ssh-worktrees.gif" type="image/gif"><img src="../assets/feature-wall/ssh-worktrees.jpg" alt="通过 SSH 使用远程 worktree" width="100%" /></picture></a>
</td>
</tr>
<tr>
<td width="50%" valign="middle">

### 标注 AI Diff

在任意 diff 行上添加评论并发回给智能体 — 评审、编辑、提交，全程无需离开 Orca。

[文档 →](https://www.onorca.dev/docs/review/annotate-ai-diff)

</td>
<td width="50%">
  <a href="https://www.onorca.dev/docs/review/annotate-ai-diff"><picture><source srcset="../assets/feature-wall/annotate-diff.gif" type="image/gif"><img src="../assets/feature-wall/annotate-diff.jpg" alt="标注 AI 生成的 diff" width="100%" /></picture></a>
</td>
</tr>
<tr>
<td width="50%" valign="middle">

### 拖文件给智能体

VS Code 的编辑器，处处自动保存 — 把文件或图片直接拖入智能体提示。

[文档 →](https://www.onorca.dev/docs/editing/file-explorer)

</td>
<td width="50%">
  <a href="https://www.onorca.dev/docs/editing/file-explorer"><picture><source srcset="../assets/feature-wall/file-drag.gif" type="image/gif"><img src="../assets/feature-wall/file-drag.jpg" alt="将文件和图片拖入智能体提示" width="100%" /></picture></a>
</td>
</tr>
<tr>
<td width="50%" valign="middle">

### Orca CLI

智能体也能驱动 Orca — 用 `orca worktree create`、`snapshot`、`click` 和 `fill` 把每个工作流脚本化。

[文档 →](https://www.onorca.dev/docs/cli/overview)

</td>
<td width="50%">
  <a href="https://www.onorca.dev/docs/cli/overview"><picture><source srcset="../assets/feature-wall/orca-cli.gif" type="image/gif"><img src="../assets/feature-wall/orca-cli.jpg" alt="从 CLI 脚本化 Orca" width="100%" /></picture></a>
</td>
</tr>
</table>

**开箱即用的还有：**

- **[快速打开](https://www.onorca.dev/docs/model/quick-open)** — 在 worktree、文件、智能体、命令和仓库上下文之间搜索，不打断你的心流。
- **[账号切换与用量追踪](https://www.onorca.dev/docs/agents/usage-tracking)** — 查看 Claude 和 Codex 的用量与限额重置时间，并且无需重新登录即可热切换账号。
- **[丰富仓库预览](https://www.onorca.dev/docs/editing/markdown)** — 在工作区中预览 Markdown、图片、PDF 和仓库文档。
- **[Computer Use](https://www.onorca.dev/docs/cli/computer-use)** — 当工作流需要真实交互时，让智能体操作桌面应用和可见 UI。
- **[通知与未读状态](https://www.onorca.dev/docs/notifications)** — 第一时间知道智能体何时完成或需要关注，并可将会话标记为未读，稍后再回来处理。
- **还有很多很多** — 我们每天发布新功能，这个列表永远跟不上。[更新日志](https://github.com/stablyai/orca/releases)才是真正的功能列表。

---

## 支持的智能体

适配**任何 CLI 智能体** — 只要能在终端里运行，就能在 Orca 里运行。

<p>
  <a href="https://docs.anthropic.com/claude/docs/claude-code"><kbd><img src="../assets/claude-logo.svg" alt="Claude Code logo" width="16" valign="middle" /> Claude Code</kbd></a> &nbsp;
  <a href="https://github.com/openai/codex"><kbd><img src="https://www.google.com/s2/favicons?domain=openai.com&sz=64" alt="Codex logo" width="16" valign="middle" /> Codex</kbd></a> &nbsp;
  <a href="https://x.ai/cli"><kbd><img src="https://www.google.com/s2/favicons?domain=x.ai&sz=64" alt="Grok logo" width="16" valign="middle" /> Grok</kbd></a> &nbsp;
  <a href="https://cursor.com/cli"><kbd><img src="https://www.google.com/s2/favicons?domain=cursor.com&sz=64" alt="Cursor logo" width="16" valign="middle" /> Cursor</kbd></a> &nbsp;
  <a href="https://docs.github.com/en/copilot/how-tos/set-up/install-copilot-cli"><kbd><img src="https://www.google.com/s2/favicons?domain=github.com&sz=64" alt="GitHub Copilot logo" width="16" valign="middle" /> GitHub Copilot</kbd></a> &nbsp;
  <a href="https://opencode.ai/docs/cli/"><kbd><img src="https://www.google.com/s2/favicons?domain=opencode.ai&sz=64" alt="OpenCode logo" width="16" valign="middle" /> OpenCode</kbd></a> &nbsp;
  <a href="https://ampcode.com/manual#install"><kbd><img src="https://www.google.com/s2/favicons?domain=ampcode.com&sz=64" alt="Amp logo" width="16" valign="middle" /> Amp</kbd></a> &nbsp;
  <a href="https://openclaude.gitlawb.com/"><kbd><img src="../../resources/openclaude-logo.png" alt="OpenClaude logo" width="16" valign="middle" /> OpenClaude</kbd></a> &nbsp;
  <a href="https://antigravity.google/docs/cli-overview"><kbd><img src="https://www.google.com/s2/favicons?domain=antigravity.google&sz=64" alt="Antigravity logo" width="16" valign="middle" /> Antigravity</kbd></a> &nbsp;
  <a href="https://pi.dev"><kbd><img src="https://pi.dev/favicon.svg" alt="Pi logo" width="16" valign="middle" /> Pi</kbd></a> &nbsp;
  <a href="https://omp.sh"><kbd><img src="https://omp.sh/favicon.svg" alt="oh-my-pi logo" width="16" valign="middle" /> oh-my-pi</kbd></a> &nbsp;
  <a href="https://hermes-agent.nousresearch.com/docs/"><kbd><img src="https://www.google.com/s2/favicons?domain=nousresearch.com&sz=64" alt="Hermes Agent logo" width="16" valign="middle" /> Hermes Agent</kbd></a> &nbsp;
  <a href="https://block.github.io/goose/docs/quickstart/"><kbd><img src="https://www.google.com/s2/favicons?domain=goose-docs.ai&sz=64" alt="Goose logo" width="16" valign="middle" /> Goose</kbd></a> &nbsp;
  <a href="https://docs.augmentcode.com/cli/overview"><kbd><img src="https://www.google.com/s2/favicons?domain=augmentcode.com&sz=64" alt="Auggie logo" width="16" valign="middle" /> Auggie</kbd></a> &nbsp;
  <a href="https://github.com/autohandai/code-cli"><kbd><img src="https://www.google.com/s2/favicons?domain=autohand.ai&sz=64" alt="Autohand Code logo" width="16" valign="middle" /> Autohand Code</kbd></a> &nbsp;
  <a href="https://github.com/charmbracelet/crush"><kbd><img src="https://www.google.com/s2/favicons?domain=charm.sh&sz=64" alt="Charm logo" width="16" valign="middle" /> Charm</kbd></a> &nbsp;
  <a href="https://docs.cline.bot/cline-cli/overview"><kbd><img src="https://www.google.com/s2/favicons?domain=cline.bot&sz=64" alt="Cline logo" width="16" valign="middle" /> Cline</kbd></a> &nbsp;
  <a href="https://www.codebuff.com/docs/help/quick-start"><kbd><img src="https://www.google.com/s2/favicons?domain=codebuff.com&sz=64" alt="Codebuff logo" width="16" valign="middle" /> Codebuff</kbd></a> &nbsp;
  <a href="https://commandcode.ai/docs/quickstart"><kbd><img src="https://www.google.com/s2/favicons?domain=commandcode.ai&sz=64" alt="Command Code logo" width="16" valign="middle" /> Command Code</kbd></a> &nbsp;
  <a href="https://docs.continue.dev/guides/cli"><kbd><img src="https://www.google.com/s2/favicons?domain=continue.dev&sz=64" alt="Continue logo" width="16" valign="middle" /> Continue</kbd></a> &nbsp;
  <a href="https://docs.factory.ai/cli/getting-started/quickstart"><kbd><img src="../assets/droid-logo.svg" alt="Droid logo" width="16" valign="middle" /> Droid</kbd></a> &nbsp;
  <a href="https://kilo.ai/docs/cli"><kbd><img src="https://raw.githubusercontent.com/Kilo-Org/kilocode/main/packages/kilo-vscode/assets/icons/kilo-light.svg" alt="Kilocode logo" width="16" valign="middle" /> Kilocode</kbd></a> &nbsp;
  <a href="https://www.kimi.com/code/docs/en/kimi-code-cli/getting-started.html"><kbd><img src="https://www.google.com/s2/favicons?domain=moonshot.cn&sz=64" alt="Kimi logo" width="16" valign="middle" /> Kimi</kbd></a> &nbsp;
  <a href="https://kiro.dev/docs/cli/"><kbd><img src="https://www.google.com/s2/favicons?domain=kiro.dev&sz=64" alt="Kiro logo" width="16" valign="middle" /> Kiro</kbd></a> &nbsp;
  <a href="https://github.com/mistralai/mistral-vibe"><kbd><img src="https://www.google.com/s2/favicons?domain=mistral.ai&sz=64" alt="Mistral Vibe logo" width="16" valign="middle" /> Mistral Vibe</kbd></a> &nbsp;
  <a href="https://github.com/QwenLM/qwen-code"><kbd><img src="https://www.google.com/s2/favicons?domain=qwenlm.github.io&sz=64" alt="Qwen Code logo" width="16" valign="middle" /> Qwen Code</kbd></a> &nbsp;
  <a href="https://support.atlassian.com/rovo/docs/install-and-run-rovo-dev-cli-on-your-device/"><kbd><img src="https://www.google.com/s2/favicons?domain=atlassian.com&sz=64" alt="Rovo Dev logo" width="16" valign="middle" /> Rovo Dev</kbd></a> &nbsp;
  <kbd>+ 任何 CLI 智能体</kbd>
</p>

---

## 安装

### 桌面端 — macOS、Windows、Linux

- **[从 onOrca.dev 下载](https://onorca.dev/download)**
- 或直接获取安装包：[macOS Apple Silicon](https://github.com/stablyai/orca/releases/latest/download/orca-macos-arm64.dmg) · [macOS Intel](https://github.com/stablyai/orca/releases/latest/download/orca-macos-x64.dmg) · [Windows (.exe)](https://github.com/stablyai/orca/releases/latest/download/orca-windows-setup.exe) · [Linux AppImage](https://github.com/stablyai/orca/releases/latest/download/orca-linux.AppImage) · [全部构建](https://github.com/stablyai/orca/releases/latest)

_也可以通过包管理器安装：_

```bash
# macOS (Homebrew)
brew install --cask stablyai/orca/orca

# Arch Linux (AUR) — or stably-orca-git to build from source
yay -S stably-orca-bin
```

### 移动 Companion 应用 — iOS、Android

与桌面应用配对，用手机监控并指挥你的智能体。

- **iOS:** [从 App Store 下载](https://apps.apple.com/us/app/orca-ide/id6766130217)
- **Android:** [下载 APK](https://github.com/stablyai/orca/releases/download/mobile-android-v0.0.31/app-release.apk)

---

## 社区与支持

- **Discord:** 加入 **[Discord](https://discord.gg/fzjDKHxv8Q)** 社区。
- **Twitter / X:** 关注 **[@orca_build](https://x.com/orca_build)** 获取更新和公告。
- **微信:** 扫描二维码加入社区。如果第一个群已满，请使用备用微信群。

  <img src="../assets/wechat-qr.png" alt="Orca 社区微信群二维码" width="160" />
  <img src="../assets/wechat-qr-backup.jpg" alt="Orca 社区备用微信群二维码" width="160" />

- **反馈与想法:** 我们发布很快。缺少什么功能？[提交功能请求](https://github.com/stablyai/orca/issues)。
- **隐私:** 查看[隐私与遥测文档](https://www.onorca.dev/docs/telemetry)，了解 Orca 收集哪些匿名使用数据以及如何退出。
- **支持我们:** 给这个仓库点 [Star](https://github.com/stablyai/orca)，关注我们的日常发布。

---

## 开发

想要贡献代码或在本地运行？请参阅我们的 [CONTRIBUTING.md](../../.github/CONTRIBUTING.md) 指南。

<a href="https://github.com/stablyai/orca/graphs/contributors">
  <img src="https://contrib.rocks/image?repo=stablyai/orca" alt="Orca 贡献者" />
</a>

## 许可证

Orca 是自由且开源的软件，遵循 [MIT 许可证](../../LICENSE)。
