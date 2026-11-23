<h1 align="center">
  <a href="https://orca.dev"><img src="../../resources/build/icon.png" alt="Orca" width="64" valign="middle" /></a> Orca
</h1>

<p align="center">
  <a href="https://github.com/stablyai/orca"><img src="https://img.shields.io/github/stars/stablyai/orca?style=flat&amp;label=%E2%98%85&amp;color=08C" alt="Sao GitHub" /></a>
  <a href="https://github.com/stablyai/orca/releases"><img src="../assets/readme-downloads.svg" alt="Tổng lượt tải trên mọi bản phát hành" /></a>
  <img src="https://img.shields.io/badge/license-MIT-08C?style=flat" alt="Giấy phép: MIT" />
  <a href="https://discord.gg/fzjDKHxv8Q"><img src="https://img.shields.io/badge/Discord-5865F2?logo=discord&logoColor=white" alt="Tham gia Discord của Orca" /></a>
  <a href="https://x.com/orca_build"><img src="https://img.shields.io/badge/X-000000?logo=x&logoColor=white" alt="Theo dõi Orca trên X" /></a>
  <img src="https://img.shields.io/badge/macOS%20%7C%20Windows%20%7C%20Linux-4493F8?style=flat-square" alt="Nền tảng hỗ trợ: macOS, Windows và Linux" />
</p>

<p align="center">
  <sub><a href="../../README.md">English</a> · <a href="README.zh-CN.md">中文</a> · <a href="README.ja.md">日本語</a> · <a href="README.ko.md">한국어</a> · <a href="README.es.md">Español</a> · <a href="README.fr.md">Français</a> · <a href="README.pt.md">Português</a> · <a href="README.tr.md">Türkçe</a> · <a href="README.ru.md">Русский</a></sub>
</p>

<h2 align="center">Bot ngay trong agent IDE của bạn.</h2>

<p align="center">
  Mã nguồn mở. Dùng đồ của bạn: Claude Code hoặc Codex của bạn, máy local hoặc remote của bạn, công cụ của bạn. Ra lệnh từ Slack hoặc điện thoại. Khi bot cần bạn, chỉ cách một tab.
</p>

<h3 align="center"><a href="https://orca.dev/download"><ins>Tải Orca</ins></a> &nbsp;·&nbsp; <a href="https://orca.dev/bots"><ins>Khám phá bot →</ins></a></h3>

<p align="center">
  <img src="../assets/readme-hero.jpg" alt="App desktop Orca với agent điều phối chạy các worker agent trong các workspace song song, và app mobile Orca ở góc" width="960" />
</p>

## Tính năng

<table>
<tr>
<td width="50%" valign="middle">

### Orca Bots

Nhờ một bot trong Slack, Linear hoặc GitHub sửa bug, rồi quay lại nhận một pull request đã test xong. Bot chạy trên Claude Code hoặc Codex của chính bạn. Mở kết quả trong Orca để review hoặc can thiệp.

[Tổng quan](https://orca.dev/bots) · [Bảo mật](https://orca.dev/docs/bots/security) · [Tài liệu →](https://orca.dev/docs/bots)

</td>
<td width="50%">
  <a href="https://orca.dev/bots"><picture><source srcset="../assets/readme-features/bots.webp" type="image/webp"><img src="../assets/readme-features/bots.poster.jpg" alt="Một bot trong Orca đã sửa bug checkout bằng hai worker, đính kèm pull request và đang chờ câu trả lời ở mục Needs you" width="100%" /></picture></a>
</td>
</tr>
<tr>
<td width="50%" valign="middle">

### Chat hoặc Terminal

Chạy mọi agent trong Chat UI hoặc CLI thuần, chuyển hội thoại qua lại mà không mất ngữ cảnh.

[Tài liệu →](https://orca.dev/docs/agents/native-chat)

</td>
<td width="50%">
  <a href="https://orca.dev/docs/agents/native-chat"><picture><source srcset="../assets/readme-features/chat-or-terminal.webp" type="image/webp"><img src="../assets/readme-features/chat-or-terminal.poster.jpg" alt="Cùng một hội thoại agent trong Chat UI và trong terminal, cạnh nhau" width="100%" /></picture></a>
</td>
</tr>
<tr>
<td width="50%" valign="middle">

### Điều phối agent

Giao việc lớn cho một agent. Nó chia việc, khởi chạy các worker agent trong workspace riêng, rồi tổng hợp kết quả về cho bạn.

[Tài liệu →](https://orca.dev/docs/cli/orchestration)

</td>
<td width="50%">
  <a href="https://orca.dev/docs/cli/orchestration"><picture><source srcset="../assets/readme-features/orchestration.webp" type="image/webp"><img src="../assets/readme-features/orchestration.poster.jpg" alt="Agent điều phối chia việc cho hai worker agent và báo cáo kết quả" width="100%" /></picture></a>
</td>
</tr>
<tr>
<td width="50%" valign="middle">

### Chạy ở bất cứ đâu

Ghép nối Remote Orca Server, làm việc trên mọi SSH host, hoặc cấp cho worktree một cloud VM riêng. Agent vẫn chạy khi laptop của bạn ngủ.

[Tài liệu →](https://orca.dev/docs/ways-to-run)

</td>
<td width="50%">
  <a href="https://orca.dev/docs/ways-to-run"><picture><source srcset="../assets/readme-features/remote.webp" type="image/webp"><img src="../assets/readme-features/remote.poster.jpg" alt="Chọn máy để chạy worktree mới, từ máy này đến SSH host hoặc môi trường riêng cho từng workspace" width="100%" /></picture></a>
</td>
</tr>
<tr>
<td width="50%" valign="middle">

### App mobile

Ghép nối Orca với app mobile để được báo khi agent cần bạn, trả lời trong chat và giữ công việc trôi trên mọi máy khi bạn rời bàn làm việc.

[iOS App Store](https://apps.apple.com/us/app/orca-ide/id6766130217) · [Google Play](https://play.google.com/store/apps/details?id=dev.orca.app) · [Android APK](https://orca.dev/download/android) · [Tài liệu →](https://orca.dev/docs/mobile)

</td>
<td width="50%">
  <a href="https://orca.dev/docs/mobile"><picture><source srcset="../assets/readme-features/mobile-companion.webp" type="image/webp"><img src="../assets/readme-features/mobile-companion.poster.jpg" alt="App mobile Orca nhận thông báo Claude cần nhập liệu, mở phiên làm việc và trả lời để agent mở PR" width="100%" /></picture></a>
</td>
</tr>
<tr>
<td width="50%" valign="middle">

### Review kết quả AI

Review diff, ghi chú ngay trên dòng đã đổi, và gửi phản hồi tập trung lại cho agent.

[Tài liệu →](https://orca.dev/docs/review/annotate-ai-diff)

</td>
<td width="50%">
  <a href="https://orca.dev/docs/review/annotate-ai-diff"><picture><source srcset="../assets/readme-features/annotate-ai-diffs.webp" type="image/webp"><img src="../assets/readme-features/annotate-ai-diffs.poster.jpg" alt="Một ghi chú trên dòng diff đã đổi, gửi lại cho agent" width="100%" /></picture></a>
</td>
</tr>
<tr>
<td width="50%" valign="middle">

### Tích hợp Git

Soạn commit message và pull request từ diff, rồi gửi check lỗi hoặc comment review PR lại cho agent sửa.

[Tài liệu →](https://orca.dev/docs/review/commit-push)

</td>
<td width="50%">
  <a href="https://orca.dev/docs/review/commit-push"><picture><source srcset="../assets/readme-features/git-integration.webp" type="image/webp"><img src="../assets/readme-features/git-integration.poster.jpg" alt="Soạn commit và pull request, rồi gửi comment review lại cho agent" width="100%" /></picture></a>
</td>
</tr>
<tr>
<td width="50%" valign="middle">

### Worktree song song

Tách nhanh công việc vào các môi trường cô lập, để nhiều agent làm song song mà không ảnh hưởng nhau.

[Tài liệu →](https://orca.dev/docs/model/worktrees)

</td>
<td width="50%">
  <a href="https://orca.dev/docs/model/worktrees"><picture><source srcset="../assets/readme-features/parallel-worktrees.webp" type="image/webp"><img src="../assets/readme-features/parallel-worktrees.poster.jpg" alt="Tạo worktree mới với agent riêng, cạnh các worktree đang chạy" width="100%" /></picture></a>
</td>
</tr>
<tr>
<td width="50%" valign="middle">

### Design Mode

Nhấn vào bất kỳ phần tử nào trong trình duyệt của Orca để sao chép HTML, style và selector của nó, rồi dán vào chat của agent.

[Tài liệu →](https://orca.dev/docs/browser/design-mode)

</td>
<td width="50%">
  <a href="https://orca.dev/docs/browser/design-mode"><picture><source srcset="../assets/readme-features/design-mode.webp" type="image/webp"><img src="../assets/readme-features/design-mode.poster.jpg" alt="Chọn một nút trong trình duyệt của Orca và gửi vào chat của agent" width="100%" /></picture></a>
</td>
</tr>
<tr>
<td width="50%" valign="middle">

### GitHub &amp; Linear, native

Xem việc GitHub và Linear ở một nơi, và mở workspace cho từng việc khi sẵn sàng làm.

[Tài liệu →](https://orca.dev/docs/review/adaptive)

</td>
<td width="50%">
  <a href="https://orca.dev/docs/review/adaptive"><picture><source srcset="../assets/readme-features/github-linear-tasks.webp" type="image/webp"><img src="../assets/readme-features/github-linear-tasks.poster.jpg" alt="Issue GitHub và Linear trong Orca, với workspace mở từ một issue Linear" width="100%" /></picture></a>
</td>
</tr>
<tr>
<td width="50%" valign="middle">

### Orca CLI

Bạn làm được gì trong Orca, agent cũng làm được: tạo worktree, khởi chạy worker, điều khiển trình duyệt và app desktop, lên lịch automation — tất cả từ dòng lệnh.

[Tài liệu →](https://orca.dev/docs/cli/overview)

</td>
<td width="50%">
  <a href="https://orca.dev/docs/cli/overview"><picture><source srcset="../assets/readme-features/orca-cli.webp" type="image/webp"><img src="../assets/readme-features/orca-cli.poster.jpg" alt="Một agent chạy orca worktree create để khởi chạy worker trong worktree mới" width="100%" /></picture></a>
</td>
</tr>
<tr>
<td width="50%" valign="middle">

### Plugin

Theme, editor, ngôn ngữ và panel từ cộng đồng, cài trong một cú nhấn.

[Xem plugin →](https://orca.dev/plugins)

</td>
<td width="50%">
  <a href="https://orca.dev/plugins"><picture><source srcset="../assets/readme-features/plugins.webp" type="image/webp"><img src="../assets/readme-features/plugins.poster.jpg" alt="Cài theme Orca Midnight từ catalog plugin" width="100%" /></picture></a>
</td>
</tr>
<tr>
<td width="50%" valign="middle">

### Chia pane tùy ý

Đặt agent, terminal, trình duyệt và diff cạnh nhau trong các pane chia theo đúng công việc.

[Tài liệu →](https://orca.dev/docs/model/tabs-panes-splits)

</td>
<td width="50%">
  <a href="https://orca.dev/docs/model/tabs-panes-splits"><picture><source srcset="../assets/readme-features/split-anything.webp" type="image/webp"><img src="../assets/readme-features/split-anything.poster.jpg" alt="Kéo tab thành các pane chia với agent, trình duyệt, terminal và diff" width="100%" /></picture></a>
</td>
</tr>
</table>

**Kèm theo sẵn:**

- **[Lịch &amp; trigger cho bot](https://orca.dev/docs/bots#put-it-on-a-schedule)**: chạy bot 9 giờ mỗi ngày làm việc, hoặc khi pull request mở, một check lỗi, hay webhook kích hoạt.
- **[Bộ nhớ bot bằng Markdown](https://orca.dev/docs/bots/security#what-you-can-review)**: soul và bộ nhớ của bot là file Markdown thuần (`SOUL.md`, `MEMORY.md`) — bạn đọc và sửa được.
- **[Kéo file cho agent](https://orca.dev/docs/editing/file-explorer)**: kéo file từ explorer, hoặc ảnh từ desktop, thẳng vào prompt của agent.
- **[Nhảy tới bất cứ đâu](https://orca.dev/docs/model/quick-open)**: một phím tắt nhảy tới mọi workspace hoặc tab trên mọi repo và host.
- **[Xem trước phong phú](https://orca.dev/docs/editing/viewers)**: mở ảnh, PDF và Markdown ngay trong workspace, cạnh agent đã tạo ra chúng.
- **[Mobile Emulator](https://orca.dev/docs/cli/overview#mobile-emulator)**: chạy iOS Simulator hoặc Android emulator cạnh agent, để nó tự chạm, gõ và kiểm tra công việc của mình.
- **[Đọc chính tả](https://orca.dev/docs/settings#voice)**: nhấn phím tắt và nói. Orca gõ lời bạn nói vào prompt của agent hoặc terminal.
- **[Mức dùng &amp; tài khoản](https://orca.dev/docs/agents/usage-tracking)**: xem đã dùng bao nhiêu hạn mức agent và khi nào reset, chuyển tài khoản không cần đăng xuất.
- **[Automation](https://orca.dev/docs/cli/automations)**: lên lịch prompt chạy trên mọi repo: nâng cấp dependency hằng đêm, triage hằng tuần, quét flaky test.
- **[Computer Use](https://orca.dev/docs/cli/computer-use)**: khi không có CLI hay API, agent xem và điều khiển được app desktop cùng trình duyệt ngoài.
- **Và còn rất nhiều nữa**: chúng tôi ship mỗi ngày nên danh sách này luôn chậm hơn thực tế. [Changelog](https://github.com/stablyai/orca/releases) mới là danh sách tính năng thật.

---

## Agent được hỗ trợ

Chạy với **mọi agent CLI** — chạy được trong terminal là chạy được trong Orca.

<p>
  <a href="https://docs.anthropic.com/claude/docs/claude-code"><kbd><img src="../assets/claude-logo.svg" alt="Logo Claude Code" width="16" valign="middle" /> Claude Code</kbd></a> &nbsp;
  <a href="https://github.com/openai/codex"><kbd><img src="https://www.google.com/s2/favicons?domain=openai.com&sz=64" alt="Logo Codex" width="16" valign="middle" /> Codex</kbd></a> &nbsp;
  <a href="https://x.ai/cli"><kbd><img src="https://www.google.com/s2/favicons?domain=x.ai&sz=64" alt="Logo Grok" width="16" valign="middle" /> Grok</kbd></a> &nbsp;
  <a href="https://cursor.com/cli"><kbd><img src="https://www.google.com/s2/favicons?domain=cursor.com&sz=64" alt="Logo Cursor" width="16" valign="middle" /> Cursor</kbd></a> &nbsp;
  <a href="https://docs.github.com/en/copilot/how-tos/set-up/install-copilot-cli"><kbd><img src="https://www.google.com/s2/favicons?domain=github.com&sz=64" alt="Logo GitHub Copilot" width="16" valign="middle" /> GitHub Copilot</kbd></a> &nbsp;
  <a href="https://dev.meta.ai/docs/muse-code"><kbd><img src="../../src/shared/agent-icons/muse.png" alt="Logo Muse" width="16" valign="middle" /> Muse</kbd></a> &nbsp;
  <a href="https://deepseek-harness.github.io/deepseek-harness/"><kbd><img src="../../src/shared/agent-icons/dsh.png" alt="Logo DeepSeek Harness" width="16" valign="middle" /> DeepSeek Harness</kbd></a> &nbsp;
  <a href="https://zcode.z.ai/en/docs"><kbd><img src="../../src/shared/agent-icons/zcode.png" alt="Logo ZCode" width="16" valign="middle" /> ZCode</kbd></a> &nbsp;
  <a href="https://opencode.ai/docs/cli/"><kbd><img src="https://www.google.com/s2/favicons?domain=opencode.ai&sz=64" alt="Logo OpenCode" width="16" valign="middle" /> OpenCode</kbd></a> &nbsp;
  <a href="https://mimo.xiaomi.com/coder"><kbd><img src="https://www.google.com/s2/favicons?domain=mimo.xiaomi.com&sz=64" alt="Logo MiMo Code" width="16" valign="middle" /> MiMo Code</kbd></a> &nbsp;
  <a href="https://ampcode.com/manual#install"><kbd><img src="https://www.google.com/s2/favicons?domain=ampcode.com&sz=64" alt="Logo Amp" width="16" valign="middle" /> Amp</kbd></a> &nbsp;
  <a href="https://openclaude.gitlawb.com/"><kbd><img src="../../resources/openclaude-logo.png" alt="Logo OpenClaude" width="16" valign="middle" /> OpenClaude</kbd></a> &nbsp;
  <a href="https://antigravity.google/docs/cli-overview"><kbd><img src="https://www.google.com/s2/favicons?domain=antigravity.google&sz=64" alt="Logo Antigravity" width="16" valign="middle" /> Antigravity</kbd></a> &nbsp;
  <a href="https://pi.dev"><kbd><img src="https://pi.dev/favicon.svg" alt="Logo Pi" width="16" valign="middle" /> Pi</kbd></a> &nbsp;
  <a href="https://omp.sh"><kbd><img src="https://omp.sh/favicon.svg" alt="Logo oh-my-pi" width="16" valign="middle" /> oh-my-pi</kbd></a> &nbsp;
  <a href="https://hermes-agent.nousresearch.com/docs/"><kbd><img src="https://www.google.com/s2/favicons?domain=nousresearch.com&sz=64" alt="Logo Hermes Agent" width="16" valign="middle" /> Hermes Agent</kbd></a> &nbsp;
  <a href="https://devin.ai/cli"><kbd><img src="https://www.google.com/s2/favicons?domain=devin.ai&sz=64" alt="Logo Devin" width="16" valign="middle" /> Devin</kbd></a> &nbsp;
  <a href="https://goose-docs.ai/docs/quickstart/"><kbd><img src="https://www.google.com/s2/favicons?domain=goose-docs.ai&sz=64" alt="Logo Goose" width="16" valign="middle" /> Goose</kbd></a> &nbsp;
  <a href="https://docs.augmentcode.com/cli/overview"><kbd><img src="https://www.google.com/s2/favicons?domain=augmentcode.com&sz=64" alt="Logo Auggie" width="16" valign="middle" /> Auggie</kbd></a> &nbsp;
  <a href="https://github.com/autohandai/code-cli"><kbd><img src="https://www.google.com/s2/favicons?domain=autohand.ai&sz=64" alt="Logo Autohand Code" width="16" valign="middle" /> Autohand Code</kbd></a> &nbsp;
  <a href="https://github.com/charmbracelet/crush"><kbd><img src="https://www.google.com/s2/favicons?domain=charm.sh&sz=64" alt="Logo Charm" width="16" valign="middle" /> Charm</kbd></a> &nbsp;
  <a href="https://docs.cline.bot/cline-cli/overview"><kbd><img src="https://www.google.com/s2/favicons?domain=cline.bot&sz=64" alt="Logo Cline" width="16" valign="middle" /> Cline</kbd></a> &nbsp;
  <a href="https://www.codebuddy.ai/cli"><kbd><img src="https://www.google.com/s2/favicons?domain=codebuddy.ai&sz=64" alt="Logo CodeBuddy" width="16" valign="middle" /> CodeBuddy</kbd></a> &nbsp;
  <a href="https://www.codebuff.com/docs/help/quick-start"><kbd><img src="https://www.google.com/s2/favicons?domain=codebuff.com&sz=64" alt="Logo Codebuff" width="16" valign="middle" /> Codebuff</kbd></a> &nbsp;
  <a href="https://freebuff.com"><kbd><img src="../../src/shared/agent-icons/freebuff.png" alt="Logo Freebuff" width="16" valign="middle" /> Freebuff</kbd></a> &nbsp;
  <a href="https://commandcode.ai/docs/quickstart"><kbd><img src="https://www.google.com/s2/favicons?domain=commandcode.ai&sz=64" alt="Logo Command Code" width="16" valign="middle" /> Command Code</kbd></a> &nbsp;
  <a href="https://docs.continue.dev/cli/quickstart"><kbd><img src="https://www.google.com/s2/favicons?domain=continue.dev&sz=64" alt="Logo Continue" width="16" valign="middle" /> Continue</kbd></a> &nbsp;
  <a href="https://docs.factory.ai/cli/getting-started/quickstart"><kbd><img src="../assets/droid-logo.svg" alt="Logo Droid" width="16" valign="middle" /> Droid</kbd></a> &nbsp;
  <a href="https://kilo.ai/docs/cli"><kbd><img src="https://raw.githubusercontent.com/Kilo-Org/kilocode/main/packages/kilo-vscode/assets/icons/kilo-light.svg" alt="Logo Kilocode" width="16" valign="middle" /> Kilocode</kbd></a> &nbsp;
  <a href="https://www.kimi.com/code/docs/en/kimi-code-cli/getting-started.html"><kbd><img src="https://www.google.com/s2/favicons?domain=moonshot.cn&sz=64" alt="Logo Kimi" width="16" valign="middle" /> Kimi</kbd></a> &nbsp;
  <a href="https://kiro.dev/docs/cli/"><kbd><img src="https://www.google.com/s2/favicons?domain=kiro.dev&sz=64" alt="Logo Kiro" width="16" valign="middle" /> Kiro</kbd></a> &nbsp;
  <a href="https://github.com/mistralai/mistral-vibe"><kbd><img src="https://www.google.com/s2/favicons?domain=mistral.ai&sz=64" alt="Logo Mistral Vibe" width="16" valign="middle" /> Mistral Vibe</kbd></a> &nbsp;
  <a href="https://github.com/QwenLM/qwen-code"><kbd><img src="https://www.google.com/s2/favicons?domain=qwenlm.github.io&sz=64" alt="Logo Qwen Code" width="16" valign="middle" /> Qwen Code</kbd></a> &nbsp;
  <a href="https://support.atlassian.com/rovo/docs/install-and-run-rovo-dev-cli-on-your-device/"><kbd><img src="https://www.google.com/s2/favicons?domain=atlassian.com&sz=64" alt="Logo Rovo Dev" width="16" valign="middle" /> Rovo Dev</kbd></a> &nbsp;
  <kbd>+ bất kỳ agent CLI nào</kbd>
</p>

---

## Cài đặt

### Desktop — macOS, Windows, Linux

- **[Tải từ orca.dev](https://orca.dev/download)**
- Hoặc lấy bản build trực tiếp: [macOS Apple Silicon](https://github.com/stablyai/orca/releases/latest/download/orca-macos-arm64.dmg) · [macOS Intel](https://github.com/stablyai/orca/releases/latest/download/orca-macos-x64.dmg) · [Windows (.exe)](https://github.com/stablyai/orca/releases/latest/download/orca-windows-setup.exe) · [Linux AppImage](https://github.com/stablyai/orca/releases/latest/download/orca-linux.AppImage) · [Mọi bản build](https://github.com/stablyai/orca/releases/latest)

_Hoặc qua trình quản lý gói:_

```bash
# macOS (Homebrew)
# Luôn dùng tên đầy đủ; `orca` trần là một cask Plotly không liên quan.
brew install --cask stablyai/orca/orca
# Nâng cấp bản đã cài
brew upgrade --cask stablyai/orca/orca
# Bản release candidate (xung đột với cask stable; gỡ bản stable trước)
brew install --cask stablyai/orca/orca@rc

# Arch Linux (AUR) — hoặc stably-orca-git để build từ source
yay -S stably-orca-bin
```

### App mobile — iOS, Android

Ghép nối với app desktop để theo dõi và điều khiển agent từ điện thoại.

- **iOS:** [Tải trên App Store](https://apps.apple.com/us/app/orca-ide/id6766130217)
- **Android:** [Google Play](https://play.google.com/store/apps/details?id=dev.orca.app) · [Tải APK](https://orca.dev/download/android) · [Hướng dẫn cài đặt](https://orca.dev/docs/android-apk)

---

## Cộng đồng &amp; hỗ trợ

- **Discord:** Tham gia cộng đồng trên **[Discord](https://discord.gg/fzjDKHxv8Q)**.
- **Twitter / X:** Theo dõi **[@orca_build](https://x.com/orca_build)** để nhận tin cập nhật và thông báo.
- **WeChat:** Quét để tham gia nhóm WeChat của cộng đồng Orca.

  <img src="../assets/wechat-qr.jpg" alt="Mã QR WeChat của cộng đồng Orca" width="160" />

- **Phản hồi &amp; ý tưởng:** Chúng tôi ship nhanh. Thiếu gì đó? [Đề xuất tính năng mới](https://github.com/stablyai/orca/issues).
- **Quyền riêng tư:** Xem [tài liệu quyền riêng tư &amp; telemetry](https://orca.dev/docs/telemetry) để biết Orca thu thập dữ liệu dùng ẩn danh nào và cách tắt.
- **Ủng hộ:** [Star](https://github.com/stablyai/orca) repo này để theo dõi các bản ship hằng ngày của chúng tôi.

---

## Phát triển

Muốn đóng góp hoặc chạy local? Xem hướng dẫn [CONTRIBUTING.md](../../.github/CONTRIBUTING.md).

<a href="https://github.com/stablyai/orca/graphs/contributors">
  <img src="https://contrib.rocks/image?repo=stablyai/orca&max=500&columns=30" alt="Người đóng góp cho Orca" />
</a>

<p align="center">
  <img src="../assets/star-history.png" alt="Biểu đồ lịch sử sao GitHub của stablyai/orca" width="880" />
</p>

## Bản build đã ký

Chữ ký số Windows do [SignPath.io](https://signpath.io) tài trợ/cung cấp, chứng thư bởi [SignPath Foundation](https://signpath.org).

## Giấy phép

Orca miễn phí và mã nguồn mở theo [Giấy phép MIT](../../LICENSE).
