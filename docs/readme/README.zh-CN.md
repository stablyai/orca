<h1 align="center">
  <a href="https://orca.dev"><img src="../../resources/build/icon.png" alt="Orca" width="64" valign="middle" /></a> Orca
</h1>

<p align="center">
  <a href="https://github.com/stablyai/orca"><img src="https://img.shields.io/github/stars/stablyai/orca?style=flat&amp;label=%E2%98%85&amp;color=08C" alt="GitHub Star 数" /></a>
  <a href="https://github.com/stablyai/orca/releases"><img src="../assets/readme-downloads.svg" alt="所有版本的总下载量" /></a>
  <img src="https://img.shields.io/badge/license-MIT-08C?style=flat" alt="许可证：MIT" />
  <a href="https://discord.gg/fzjDKHxv8Q"><img src="https://img.shields.io/badge/Discord-5865F2?logo=discord&amp;logoColor=white" alt="加入 Orca Discord" /></a>
  <a href="https://x.com/orca_build"><img src="https://img.shields.io/badge/X-000000?logo=x&amp;logoColor=white" alt="在 X 上关注 Orca" /></a>
  <img src="https://img.shields.io/badge/macOS%20%7C%20Windows%20%7C%20Linux-4493F8?style=flat-square" alt="支持的平台：macOS、Windows 和 Linux" />
</p>

<p align="center">
  <sub><a href="../../README.md">English</a> · <a href="README.ja.md">日本語</a> · <a href="README.ko.md">한국어</a> · <a href="README.es.md">Español</a> · <a href="README.fr.md">Français</a> · <a href="README.pt.md">Português</a> · <a href="README.tr.md">Türkçe</a> · <a href="README.ru.md">Русский</a></sub>
</p>

<h2 align="center">把 Bots 带进你的 Agent IDE。</h2>

<p align="center">
  开源、开放且由你掌控：使用自己的 Claude Code 或 Codex，在本地或远程机器上运行，并接入自己的工具。你可以通过 Slack 或手机向 Bot 分配任务；当它需要你介入时，打开 Orca 即可继续处理。
</p>

<h3 align="center"><a href="https://orca.dev/download"><ins>下载 Orca</ins></a> &nbsp;·&nbsp; <a href="https://orca.dev/bots"><ins>探索 Bots →</ins></a></h3>

<p align="center">
  <img src="../assets/readme-hero.jpg" alt="Orca 桌面应用中，协调 Agent 在多个独立工作区调度 Worker Agent，旁边展示 Orca 移动应用" width="960" />
</p>

## 功能特性

<table>
<tr>
<td width="50%" valign="middle">

### Orca Bots

在 Slack、Linear 或 GitHub 中向 Bot 分配任务，例如修复一个 Bug；Bot 会调用你自己的 Claude Code 或 Codex 执行任务，并在完成后提供经过测试的 Pull Request。你可以在 Orca 中打开任务结果进行检查，或随时接手处理。

[功能介绍](https://orca.dev/bots) · [安全说明](https://orca.dev/docs/bots/security) · [文档 →](https://orca.dev/docs/bots)

</td>
<td width="50%">
  <a href="https://orca.dev/bots"><picture><source srcset="../assets/readme-features/bots.webp" type="image/webp"><img src="../assets/readme-features/bots.poster.jpg" alt="Orca Bot 调度两个 Worker 修复结账问题、关联 Pull Request，并等待用户确认" width="100%" /></picture></a>
</td>
</tr>
<tr>
<td width="50%" valign="middle">

### Chat 或 Terminal

既可以在 Orca 的 Chat 界面中与 Agent 交互，也可以直接使用原始 CLI。两种模式之间可以切换，并保留原有对话上下文。

[文档 →](https://orca.dev/docs/agents/native-chat)

</td>
<td width="50%">
  <a href="https://orca.dev/docs/agents/native-chat"><picture><source srcset="../assets/readme-features/chat-or-terminal.webp" type="image/webp"><img src="../assets/readme-features/chat-or-terminal.poster.jpg" alt="同一个 Agent 会话同时展示在 Chat 界面和终端中" width="100%" /></picture></a>
</td>
</tr>
<tr>
<td width="50%" valign="middle">

### Agent 编排

把复杂任务交给一个协调 Agent，由它拆分任务、在各自独立的工作区中启动多个 Worker Agent，并在完成后汇总结果。多个 Agent 可以并行处理不同子任务。

[文档 →](https://orca.dev/docs/cli/orchestration)

</td>
<td width="50%">
  <a href="https://orca.dev/docs/cli/orchestration"><picture><source srcset="../assets/readme-features/orchestration.webp" type="image/webp"><img src="../assets/readme-features/orchestration.poster.jpg" alt="协调 Agent 将任务拆分给两个 Worker Agent 并汇总执行结果" width="100%" /></picture></a>
</td>
</tr>
<tr>
<td width="50%" valign="middle">

### 随处运行

连接远程 Orca Server、通过 SSH 使用其他机器，或为每个 Worktree 配置独立的云端虚拟机。即使笔记本电脑休眠，Agent 也可以继续在远程环境中运行。

[文档 →](https://orca.dev/docs/ways-to-run)

</td>
<td width="50%">
  <a href="https://orca.dev/docs/ways-to-run"><picture><source srcset="../assets/readme-features/remote.webp" type="image/webp"><img src="../assets/readme-features/remote.poster.jpg" alt="为新 Worktree 选择本机、SSH 主机或独立工作区运行环境" width="100%" /></picture></a>
</td>
</tr>
<tr>
<td width="50%" valign="middle">

### 移动应用

将 Orca 与移动应用配对。当 Agent 需要你处理问题时，手机会收到通知；你可以直接在手机上回复，并在离开电脑时继续跟进不同机器上的任务。

[iOS App Store](https://apps.apple.com/us/app/orca-ide/id6766130217) · [Google Play](https://play.google.com/store/apps/details?id=dev.orca.app) · [Android APK](https://orca.dev/download/android) · [文档 →](https://orca.dev/docs/mobile)

</td>
<td width="50%">
  <a href="https://orca.dev/docs/mobile"><picture><source srcset="../assets/readme-features/mobile-companion.webp" type="image/webp"><img src="../assets/readme-features/mobile-companion.poster.jpg" alt="Orca 移动应用收到 Claude 需要输入的通知，用户打开会话并回复，Agent 随后创建 Pull Request" width="100%" /></picture></a>
</td>
</tr>
<tr>
<td width="50%" valign="middle">

### 审查 AI 生成的代码

检查代码 Diff，在具体修改行上添加批注，再将有针对性的反馈发送给 Agent，帮助它根据审查意见继续修改。

[文档 →](https://orca.dev/docs/review/annotate-ai-diff)

</td>
<td width="50%">
  <a href="https://orca.dev/docs/review/annotate-ai-diff"><picture><source srcset="../assets/readme-features/annotate-ai-diffs.webp" type="image/webp"><img src="../assets/readme-features/annotate-ai-diffs.poster.jpg" alt="在代码 Diff 的修改行上添加批注并发送给 Agent" width="100%" /></picture></a>
</td>
</tr>
<tr>
<td width="50%" valign="middle">

### Git 集成

根据代码 Diff 起草 Commit 信息和 Pull Request；也可以将 CI 检查失败信息或 PR 审查评论发送给 Agent，让它协助修复问题。

[文档 →](https://orca.dev/docs/review/commit-push)

</td>
<td width="50%">
  <a href="https://orca.dev/docs/review/commit-push"><picture><source srcset="../assets/readme-features/git-integration.webp" type="image/webp"><img src="../assets/readme-features/git-integration.poster.jpg" alt="起草 Commit 和 Pull Request，并将审查评论反馈给 Agent" width="100%" /></picture></a>
</td>
</tr>
<tr>
<td width="50%" valign="middle">

### 并行 Worktree

快速创建相互隔离的工作环境，让多个 Agent 在不同 Worktree 中并行工作，避免相互干扰。

[文档 →](https://orca.dev/docs/model/worktrees)

</td>
<td width="50%">
  <a href="https://orca.dev/docs/model/worktrees"><picture><source srcset="../assets/readme-features/parallel-worktrees.webp" type="image/webp"><img src="../assets/readme-features/parallel-worktrees.poster.jpg" alt="在多个并行 Worktree 中分别启动 Agent" width="100%" /></picture></a>
</td>
</tr>
<tr>
<td width="50%" valign="middle">

### 设计模式

在 Orca 内置浏览器中点击任意页面元素，即可获取该元素的 HTML、样式和选择器，并将这些信息发送到 Agent 对话中，辅助页面开发与调试。

[文档 →](https://orca.dev/docs/browser/design-mode)

</td>
<td width="50%">
  <a href="https://orca.dev/docs/browser/design-mode"><picture><source srcset="../assets/readme-features/design-mode.webp" type="image/webp"><img src="../assets/readme-features/design-mode.poster.jpg" alt="在 Orca 浏览器中选中页面按钮并将元素信息发送给 Agent" width="100%" /></picture></a>
</td>
</tr>
<tr>
<td width="50%" valign="middle">

### 原生集成 GitHub 与 Linear

在同一个地方查看 GitHub 和 Linear 中的任务，并根据需要为每个任务创建工作区，直接开始开发。

[文档 →](https://orca.dev/docs/review/linear)

</td>
<td width="50%">
  <a href="https://orca.dev/docs/review/linear"><picture><source srcset="../assets/readme-features/github-linear-tasks.webp" type="image/webp"><img src="../assets/readme-features/github-linear-tasks.poster.jpg" alt="在 Orca 中查看 GitHub 和 Linear 任务，并从 Linear Issue 创建工作区" width="100%" /></picture></a>
</td>
</tr>
<tr>
<td width="50%" valign="middle">

### Orca CLI

Agent 也可以通过命令行驱动 Orca：创建 Worktree、启动 Worker、操作浏览器和桌面应用，以及安排自动化任务。

[文档 →](https://orca.dev/docs/cli/overview)

</td>
<td width="50%">
  <a href="https://orca.dev/docs/cli/overview"><picture><source srcset="../assets/readme-features/orca-cli.webp" type="image/webp"><img src="../assets/readme-features/orca-cli.poster.jpg" alt="Agent 通过 orca worktree create 命令在新 Worktree 中启动 Worker" width="100%" /></picture></a>
</td>
</tr>
<tr>
<td width="50%" valign="middle">

### 插件

通过社区插件扩展 Orca，可一键安装主题、编辑器、语言支持和面板。

[浏览插件 →](https://orca.dev/plugins)

</td>
<td width="50%">
  <a href="https://orca.dev/plugins"><picture><source srcset="../assets/readme-features/plugins.webp" type="image/webp"><img src="../assets/readme-features/plugins.poster.jpg" alt="从插件目录安装 Orca Midnight 主题" width="100%" /></picture></a>
</td>
</tr>
<tr>
<td width="50%" valign="middle">

### 自由分屏布局

将 Agent、终端、浏览器和代码 Diff 按照任务需要并排排列，自由组合工作区布局。

[文档 →](https://orca.dev/docs/model/tabs-panes-splits)

</td>
<td width="50%">
  <a href="https://orca.dev/docs/model/tabs-panes-splits"><picture><source srcset="../assets/readme-features/split-anything.webp" type="image/webp"><img src="../assets/readme-features/split-anything.poster.jpg" alt="将 Agent、浏览器、终端和代码 Diff 拖入分屏布局" width="100%" /></picture></a>
</td>
</tr>
</table>

**此外还包括：**

- **[Bot 定时任务与触发器](https://orca.dev/docs/bots#put-it-on-a-schedule)**：按工作日定时运行 Bot，或在 Pull Request 创建、检查失败、Webhook 触发时自动启动任务。
- **[基于 Markdown 的 Bot 记忆](https://orca.dev/docs/bots/security#what-you-can-review)**：Bot 的角色设定和记忆以 `SOUL.md`、`MEMORY.md` 等 Markdown 文件保存，内容可查看、可编辑。
- **[向 Agent 拖入文件](https://orca.dev/docs/editing/file-explorer)**：将文件浏览器中的文件或桌面上的图片直接拖入 Agent 提示词。
- **[快速跳转](https://orca.dev/docs/model/quick-open)**：通过一个快捷键，在不同仓库、主机和工作区中的标签页之间快速查找和切换。
- **[文件预览](https://orca.dev/docs/editing/viewers)**：在工作区中直接查看图片、PDF 和 Markdown 文件，并与 Agent 的工作内容并排展示。
- **[移动设备模拟器](https://orca.dev/docs/cli/overview#mobile-emulator)**：在 Agent 旁运行 iOS Simulator 或 Android Emulator，让 Agent 执行点击、输入并检查结果。
- **[语音输入](https://orca.dev/docs/settings#voice)**：通过快捷键语音输入，内容可直接进入 Agent 提示词或终端。
- **[用量与账号管理](https://orca.dev/docs/agents/usage-tracking)**：查看 Agent 用量和限额重置时间，并在无需退出登录的情况下切换账号。
- **[自动化任务](https://orca.dev/docs/cli/automations)**：为任意仓库安排定时提示词任务，例如夜间依赖更新、每周问题整理和不稳定测试排查。
- **[Computer Use](https://orca.dev/docs/cli/computer-use)**：当任务没有可用的 CLI 或 API 时，让 Agent 观察并操作桌面应用及外部浏览器。
- **更多功能**：Orca 持续快速迭代，以上列表可能无法涵盖全部功能。请查看[更新日志](https://github.com/stablyai/orca/releases)了解最新变化。

---

## 支持的 Agent

Orca 兼容**任何 CLI Agent**：只要能够在终端中运行，就可以在 Orca 中使用。

<p>
  <a href="https://docs.anthropic.com/claude/docs/claude-code"><kbd><img src="../assets/claude-logo.svg" alt="Claude Code logo" width="16" valign="middle" /> Claude Code</kbd></a> &nbsp;
  <a href="https://github.com/openai/codex"><kbd><img src="https://www.google.com/s2/favicons?domain=openai.com&amp;sz=64" alt="Codex logo" width="16" valign="middle" /> Codex</kbd></a> &nbsp;
  <a href="https://x.ai/cli"><kbd><img src="https://www.google.com/s2/favicons?domain=x.ai&amp;sz=64" alt="Grok logo" width="16" valign="middle" /> Grok</kbd></a> &nbsp;
  <a href="https://cursor.com/cli"><kbd><img src="https://www.google.com/s2/favicons?domain=cursor.com&amp;sz=64" alt="Cursor logo" width="16" valign="middle" /> Cursor</kbd></a> &nbsp;
  <a href="https://docs.github.com/en/copilot/how-tos/set-up/install-copilot-cli"><kbd><img src="https://www.google.com/s2/favicons?domain=github.com&amp;sz=64" alt="GitHub Copilot logo" width="16" valign="middle" /> GitHub Copilot</kbd></a> &nbsp;
  <a href="https://dev.meta.ai/docs/muse-code"><kbd><img src="../../src/shared/agent-icons/muse.png" alt="Muse logo" width="16" valign="middle" /> Muse</kbd></a> &nbsp;
  <a href="https://deepseek-harness.github.io/deepseek-harness/"><kbd><img src="../../src/shared/agent-icons/dsh.png" alt="DeepSeek Harness logo" width="16" valign="middle" /> DeepSeek Harness</kbd></a> &nbsp;
  <a href="https://zcode.z.ai/en/docs"><kbd><img src="../../src/shared/agent-icons/zcode.png" alt="ZCode logo" width="16" valign="middle" /> ZCode</kbd></a> &nbsp;
  <a href="https://opencode.ai/docs/cli/"><kbd><img src="https://www.google.com/s2/favicons?domain=opencode.ai&amp;sz=64" alt="OpenCode logo" width="16" valign="middle" /> OpenCode</kbd></a> &nbsp;
  <a href="https://mimo.xiaomi.com/coder"><kbd><img src="https://www.google.com/s2/favicons?domain=mimo.xiaomi.com&amp;sz=64" alt="MiMo Code logo" width="16" valign="middle" /> MiMo Code</kbd></a> &nbsp;
  <a href="https://ampcode.com/manual#install"><kbd><img src="https://www.google.com/s2/favicons?domain=ampcode.com&amp;sz=64" alt="Amp logo" width="16" valign="middle" /> Amp</kbd></a> &nbsp;
  <a href="https://openclaude.gitlawb.com/"><kbd><img src="../../resources/openclaude-logo.png" alt="OpenClaude logo" width="16" valign="middle" /> OpenClaude</kbd></a> &nbsp;
  <a href="https://antigravity.google/docs/cli-overview"><kbd><img src="https://www.google.com/s2/favicons?domain=antigravity.google&amp;sz=64" alt="Antigravity logo" width="16" valign="middle" /> Antigravity</kbd></a> &nbsp;
  <a href="https://pi.dev"><kbd><img src="https://pi.dev/favicon.svg" alt="Pi logo" width="16" valign="middle" /> Pi</kbd></a> &nbsp;
  <a href="https://omp.sh"><kbd><img src="https://omp.sh/favicon.svg" alt="oh-my-pi logo" width="16" valign="middle" /> oh-my-pi</kbd></a> &nbsp;
  <a href="https://hermes-agent.nousresearch.com/docs/"><kbd><img src="https://www.google.com/s2/favicons?domain=nousresearch.com&amp;sz=64" alt="Hermes Agent logo" width="16" valign="middle" /> Hermes Agent</kbd></a> &nbsp;
  <a href="https://devin.ai/cli"><kbd><img src="https://www.google.com/s2/favicons?domain=devin.ai&amp;sz=64" alt="Devin logo" width="16" valign="middle" /> Devin</kbd></a> &nbsp;
  <a href="https://goose-docs.ai/docs/quickstart/"><kbd><img src="https://www.google.com/s2/favicons?domain=goose-docs.ai&amp;sz=64" alt="Goose logo" width="16" valign="middle" /> Goose</kbd></a> &nbsp;
  <a href="https://docs.augmentcode.com/cli/overview"><kbd><img src="https://www.google.com/s2/favicons?domain=augmentcode.com&amp;sz=64" alt="Auggie logo" width="16" valign="middle" /> Auggie</kbd></a> &nbsp;
  <a href="https://github.com/autohandai/code-cli"><kbd><img src="https://www.google.com/s2/favicons?domain=autohand.ai&amp;sz=64" alt="Autohand Code logo" width="16" valign="middle" /> Autohand Code</kbd></a> &nbsp;
  <a href="https://github.com/charmbracelet/crush"><kbd><img src="https://www.google.com/s2/favicons?domain=charm.sh&amp;sz=64" alt="Charm logo" width="16" valign="middle" /> Charm</kbd></a> &nbsp;
  <a href="https://docs.cline.bot/cline-cli/overview"><kbd><img src="https://www.google.com/s2/favicons?domain=cline.bot&amp;sz=64" alt="Cline logo" width="16" valign="middle" /> Cline</kbd></a> &nbsp;
  <a href="https://www.codebuddy.ai/cli"><kbd><img src="https://www.google.com/s2/favicons?domain=codebuddy.ai&amp;sz=64" alt="CodeBuddy logo" width="16" valign="middle" /> CodeBuddy</kbd></a> &nbsp;
  <a href="https://www.codebuff.com/docs/help/quick-start"><kbd><img src="https://www.google.com/s2/favicons?domain=codebuff.com&amp;sz=64" alt="Codebuff logo" width="16" valign="middle" /> Codebuff</kbd></a> &nbsp;
  <a href="https://freebuff.com"><kbd><img src="../../src/shared/agent-icons/freebuff.png" alt="Freebuff logo" width="16" valign="middle" /> Freebuff</kbd></a> &nbsp;
  <a href="https://commandcode.ai/docs/quickstart"><kbd><img src="https://www.google.com/s2/favicons?domain=commandcode.ai&amp;sz=64" alt="Command Code logo" width="16" valign="middle" /> Command Code</kbd></a> &nbsp;
  <a href="https://docs.continue.dev/cli/quickstart"><kbd><img src="https://www.google.com/s2/favicons?domain=continue.dev&amp;sz=64" alt="Continue logo" width="16" valign="middle" /> Continue</kbd></a> &nbsp;
  <a href="https://docs.factory.ai/cli/getting-started/quickstart"><kbd><img src="../assets/droid-logo.svg" alt="Droid logo" width="16" valign="middle" /> Droid</kbd></a> &nbsp;
  <a href="https://kilo.ai/docs/cli"><kbd><img src="https://raw.githubusercontent.com/Kilo-Org/kilocode/main/packages/kilo-vscode/assets/icons/kilo-light.svg" alt="Kilocode logo" width="16" valign="middle" /> Kilocode</kbd></a> &nbsp;
  <a href="https://www.kimi.com/code/docs/en/kimi-code-cli/getting-started.html"><kbd><img src="https://www.google.com/s2/favicons?domain=moonshot.cn&amp;sz=64" alt="Kimi logo" width="16" valign="middle" /> Kimi</kbd></a> &nbsp;
  <a href="https://kiro.dev/docs/cli/"><kbd><img src="https://www.google.com/s2/favicons?domain=kiro.dev&amp;sz=64" alt="Kiro logo" width="16" valign="middle" /> Kiro</kbd></a> &nbsp;
  <a href="https://github.com/mistralai/mistral-vibe"><kbd><img src="https://www.google.com/s2/favicons?domain=mistral.ai&amp;sz=64" alt="Mistral Vibe logo" width="16" valign="middle" /> Mistral Vibe</kbd></a> &nbsp;
  <a href="https://github.com/QwenLM/qwen-code"><kbd><img src="https://www.google.com/s2/favicons?domain=qwenlm.github.io&amp;sz=64" alt="Qwen Code logo" width="16" valign="middle" /> Qwen Code</kbd></a> &nbsp;
  <a href="https://support.atlassian.com/rovo/docs/install-and-run-rovo-dev-cli-on-your-device/"><kbd><img src="https://www.google.com/s2/favicons?domain=atlassian.com&amp;sz=64" alt="Rovo Dev logo" width="16" valign="middle" /> Rovo Dev</kbd></a> &nbsp;
  <kbd>+ 其他 CLI Agent</kbd>
</p>

---

## 安装

### 桌面端 — macOS、Windows、Linux

- **[从 orca.dev 下载](https://orca.dev/download)**
- 或直接下载对应安装包：[macOS Apple Silicon](https://github.com/stablyai/orca/releases/latest/download/orca-macos-arm64.dmg) · [macOS Intel](https://github.com/stablyai/orca/releases/latest/download/orca-macos-x64.dmg) · [Windows (.exe)](https://github.com/stablyai/orca/releases/latest/download/orca-windows-setup.exe) · [Linux AppImage](https://github.com/stablyai/orca/releases/latest/download/orca-linux.AppImage) · [全部构建版本](https://github.com/stablyai/orca/releases/latest)

也可以通过包管理器安装：

```bash
# macOS（Homebrew）
# 请始终使用完整名称；单独的 orca 是与本项目无关的 Plotly cask。
brew install --cask stablyai/orca/orca

# 升级已有安装
brew upgrade --cask stablyai/orca/orca

# 安装 Release Candidate（与稳定版 cask 冲突，需先卸载稳定版）
brew install --cask stablyai/orca/orca@rc

# Arch Linux（AUR）；也可以使用 stably-orca-git 从源码构建
yay -S stably-orca-bin
```

### 移动应用 — iOS、Android

将移动应用与桌面端配对，即可通过手机查看 Agent 状态、接收通知并继续处理任务。

- **iOS**：[从 App Store 下载](https://apps.apple.com/us/app/orca-ide/id6766130217)
- **Android**：[Google Play](https://play.google.com/store/apps/details?id=dev.orca.app) · [下载 APK](https://orca.dev/download/android) · [APK 安装指南](https://orca.dev/docs/android-apk)

---

## 社区与支持

- **Discord**：加入 [Orca Discord 社区](https://discord.gg/fzjDKHxv8Q)。
- **Twitter / X**：关注 [@orca_build](https://x.com/orca_build)，获取项目更新和公告。
- **微信**：扫描下方二维码加入 Orca 微信社区。

  <img src="../assets/wechat-qr.jpg" alt="Orca 微信社区二维码" width="160" />

- **反馈与建议**：发现问题或有新功能想法？欢迎[提交 Issue](https://github.com/stablyai/orca/issues)。
- **隐私**：查看[隐私与遥测说明](https://orca.dev/docs/telemetry)，了解 Orca 收集哪些匿名使用数据，以及如何选择退出。
- **支持项目**：欢迎为 [Orca GitHub 仓库](https://github.com/stablyai/orca)点 Star，关注项目的持续更新。

---

## 参与开发

希望参与贡献或在本地运行 Orca？请先阅读[贡献指南](../../.github/CONTRIBUTING.md)。

<a href="https://github.com/stablyai/orca/graphs/contributors">
  <img src="https://contrib.rocks/image?repo=stablyai/orca&amp;max=500&amp;columns=30" alt="Orca 项目贡献者" />
</a>

<p align="center">
  <img src="../assets/star-history.png" alt="stablyai/orca GitHub Star 历史趋势" width="880" />
</p>

## 签名构建

Windows 版本的代码签名由 [SignPath.io](https://signpath.io) 赞助/提供，证书由 [SignPath Foundation](https://signpath.org) 提供。

## 许可证

Orca 是免费开源软件，采用 [MIT 许可证](../../LICENSE)。
