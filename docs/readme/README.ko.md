<h1 align="center">
  <a href="https://onOrca.dev"><img src="../../resources/build/icon.png" alt="Orca" width="64" valign="middle" /></a> Orca
</h1>

<p align="center">
  <a href="https://github.com/stablyai/orca/stargazers"><img src="https://badgen.net/github/stars/stablyai/orca?label=%E2%98%85" alt="GitHub 스타" /></a>
  <a href="https://github.com/stablyai/orca/releases"><img src="../assets/readme-downloads.svg" alt="전체 릴리스 누적 다운로드 수" /></a>
  <img src="https://badgen.net/github/license/stablyai/orca" alt="라이선스" />
  <a href="https://discord.gg/fzjDKHxv8Q"><img src="https://img.shields.io/badge/Discord-5865F2?logo=discord&logoColor=white" alt="Orca Discord 참여" /></a>
  <a href="https://x.com/orca_build"><img src="https://img.shields.io/badge/X-000000?logo=x&logoColor=white" alt="X에서 Orca 팔로우" /></a>
  <img src="https://img.shields.io/badge/macOS%20%7C%20Windows%20%7C%20Linux-4493F8?style=flat-square" alt="지원 플랫폼: macOS, Windows, Linux" />
</p>

<p align="center">
  <sub><a href="../../README.md">English</a> · <a href="README.es.md">Español</a> · <a href="README.pt.md">Português</a> · <a href="README.zh-CN.md">中文</a> · <a href="README.ja.md">日本語</a></sub>
</p>

<p align="center">
  <strong>100x 빌더를 위한 AI 오케스트레이터.</strong><br/>
  Claude Code, OpenClaude, Codex, OpenCode를 나란히 실행하세요 — 각 에이전트는 자체 worktree에서 실행되고 한곳에서 추적됩니다.
</p>

<h3 align="center"><a href="https://onorca.dev/download"><ins>Orca 다운로드</ins></a></h3>

<p align="center">
  <img src="../assets/readme-hero.jpg" alt="병렬 worktree에서 에이전트를 실행 중인 Orca 데스크톱 앱과 한쪽 모서리에 보이는 Orca 모바일 companion 앱" width="960" />
</p>

## 기능

<table>
<tr>
<td width="50%" valign="middle">

### 모바일 Companion

휴대폰에서 에이전트를 모니터링하고 조종하세요 — 에이전트가 완료되면 알림을 받고 어디서든 후속 지시를 보낼 수 있습니다.

[iOS App Store](https://apps.apple.com/us/app/orca-ide/id6766130217) · [Android APK](https://github.com/stablyai/orca/releases/download/mobile-android-v0.0.26/app-release.apk) · [문서 →](https://www.onorca.dev/docs/mobile)

</td>
<td width="50%">
  <a href="https://www.onorca.dev/docs/mobile"><picture><source srcset="../assets/feature-wall/mobile-companion-app-showcase.gif" type="image/gif"><img src="../assets/feature-wall/mobile-companion-app-showcase.jpg" alt="Orca 데스크톱과 모바일 companion 앱" width="100%" /></picture></a>
</td>
</tr>
<tr>
<td width="50%" valign="middle">

### 병렬 Worktree

하나의 프롬프트를 다섯 에이전트에 동시에 보내세요. 각 에이전트는 격리된 자체 git worktree에서 실행됩니다 — 결과를 비교하고 가장 좋은 것을 머지하세요.

[문서 →](https://www.onorca.dev/docs/model/worktrees)

</td>
<td width="50%">
  <a href="https://www.onorca.dev/docs/model/worktrees"><picture><source srcset="../assets/feature-wall/parallel-worktrees.gif" type="image/gif"><img src="../assets/feature-wall/parallel-worktrees.jpg" alt="병렬 worktree 오케스트레이션" width="100%" /></picture></a>
</td>
</tr>
<tr>
<td width="50%" valign="middle">

### 터미널 분할

WebGL 렌더링, 무한 분할, 재시작 후에도 유지되는 스크롤백을 갖춘 Ghostty급 터미널.

[문서 →](https://www.onorca.dev/docs/terminal)

</td>
<td width="50%">
  <a href="https://www.onorca.dev/docs/terminal"><picture><source srcset="../assets/feature-wall/terminal-splits.gif" type="image/gif"><img src="../assets/feature-wall/terminal-splits.jpg" alt="터미널 분할" width="100%" /></picture></a>
</td>
</tr>
<tr>
<td width="50%" valign="middle">

### 디자인 모드

실제 Chromium 창에서 UI 요소를 클릭하면 해당 HTML, CSS, 잘라낸 스크린샷이 에이전트 프롬프트로 바로 전송됩니다.

[문서 →](https://www.onorca.dev/docs/browser/design-mode)

</td>
<td width="50%">
  <a href="https://www.onorca.dev/docs/browser/design-mode"><picture><source srcset="../assets/feature-wall/design-mode.gif" type="image/gif"><img src="../assets/feature-wall/design-mode.jpg" alt="내장 브라우저와 디자인 모드" width="100%" /></picture></a>
</td>
</tr>
<tr>
<td width="50%" valign="middle">

### GitHub &amp; Linear 네이티브

PR, issue, 프로젝트 보드를 앱 안에서 탐색하세요 — 어떤 작업에서든 worktree를 열고 컨텍스트 전환 없이 리뷰할 수 있습니다.

[문서 →](https://www.onorca.dev/docs/review/linear)

</td>
<td width="50%">
  <a href="https://www.onorca.dev/docs/review/linear"><picture><source srcset="../assets/feature-wall/github-linear.gif" type="image/gif"><img src="../assets/feature-wall/github-linear.jpg" alt="Orca의 GitHub 및 Linear 작업 워크플로" width="100%" /></picture></a>
</td>
</tr>
<tr>
<td width="50%" valign="middle">

### SSH Worktree

강력한 원격 머신에서 에이전트를 실행하세요. 파일 편집, git, 터미널을 모두 지원하며 자동 재연결과 포트 포워딩도 포함됩니다.

[문서 →](https://www.onorca.dev/docs/ssh)

</td>
<td width="50%">
  <a href="https://www.onorca.dev/docs/ssh"><picture><source srcset="../assets/feature-wall/ssh-worktrees.gif" type="image/gif"><img src="../assets/feature-wall/ssh-worktrees.jpg" alt="SSH를 통한 원격 worktree" width="100%" /></picture></a>
</td>
</tr>
<tr>
<td width="50%" valign="middle">

### AI Diff 주석

diff의 어느 줄에든 코멘트를 남기고 에이전트에게 바로 보내세요 — Orca를 떠나지 않고 리뷰하고 수정하고 커밋할 수 있습니다.

[문서 →](https://www.onorca.dev/docs/review/annotate-ai-diff)

</td>
<td width="50%">
  <a href="https://www.onorca.dev/docs/review/annotate-ai-diff"><picture><source srcset="../assets/feature-wall/annotate-diff.gif" type="image/gif"><img src="../assets/feature-wall/annotate-diff.jpg" alt="AI가 생성한 diff에 주석 달기" width="100%" /></picture></a>
</td>
</tr>
<tr>
<td width="50%" valign="middle">

### 에이전트로 파일 드래그

어디서나 자동 저장되는 VS Code 에디터 — 파일이나 이미지를 에이전트 프롬프트로 바로 드래그하세요.

[문서 →](https://www.onorca.dev/docs/editing/file-explorer)

</td>
<td width="50%">
  <a href="https://www.onorca.dev/docs/editing/file-explorer"><picture><source srcset="../assets/feature-wall/file-drag.gif" type="image/gif"><img src="../assets/feature-wall/file-drag.jpg" alt="파일과 이미지를 에이전트 프롬프트로 드래그" width="100%" /></picture></a>
</td>
</tr>
<tr>
<td width="50%" valign="middle">

### Orca CLI

에이전트도 Orca를 조작할 수 있습니다 — `orca worktree create`, `snapshot`, `click`, `fill`로 모든 워크플로를 스크립팅하세요.

[문서 →](https://www.onorca.dev/docs/cli/overview)

</td>
<td width="50%">
  <a href="https://www.onorca.dev/docs/cli/overview"><picture><source srcset="../assets/feature-wall/orca-cli.gif" type="image/gif"><img src="../assets/feature-wall/orca-cli.jpg" alt="CLI에서 Orca 스크립팅" width="100%" /></picture></a>
</td>
</tr>
</table>

**그 밖에 기본으로 제공되는 기능:**

- **[빠른 열기](https://www.onorca.dev/docs/model/quick-open)** — 작업 흐름을 벗어나지 않고 worktree, 파일, 에이전트, 커맨드, 리포지토리 컨텍스트를 검색하세요.
- **[계정 전환 및 사용량 추적](https://www.onorca.dev/docs/agents/usage-tracking)** — Claude와 Codex의 사용량과 rate limit 초기화 시점을 확인하고, 다시 로그인하지 않고 계정을 바로 전환하세요.
- **[풍부한 리포지토리 미리보기](https://www.onorca.dev/docs/editing/markdown)** — Markdown, 이미지, PDF, 리포지토리 문서를 워크스페이스에서 미리 볼 수 있습니다.
- **[Computer Use](https://www.onorca.dev/docs/cli/computer-use)** — 워크플로에 실제 상호작용이 필요할 때 에이전트가 데스크톱 앱과 화면에 보이는 UI를 직접 조작하게 하세요.
- **[알림과 읽지 않음 상태](https://www.onorca.dev/docs/notifications)** — 에이전트가 완료되거나 주의가 필요할 때 알림을 받고, 스레드를 읽지 않음으로 표시해 나중에 다시 확인하세요.
- **그리고 훨씬 더 많은 기능** — 매일 출시하기 때문에 이 목록은 항상 뒤처져 있습니다. 진짜 기능 목록은 [체인지로그](https://github.com/stablyai/orca/releases)입니다.

---

## 지원 에이전트

**모든 CLI 에이전트**와 함께 작동합니다 — 터미널에서 실행되는 에이전트라면 Orca에서도 실행됩니다.

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
  <kbd>+ any CLI agent</kbd>
</p>

---

## 설치

### 데스크톱 — macOS, Windows, Linux

- **[onOrca.dev에서 다운로드](https://onorca.dev/download)**
- 또는 빌드를 직접 받기: [macOS Apple Silicon](https://github.com/stablyai/orca/releases/latest/download/orca-macos-arm64.dmg) · [macOS Intel](https://github.com/stablyai/orca/releases/latest/download/orca-macos-x64.dmg) · [Windows (.exe)](https://github.com/stablyai/orca/releases/latest/download/orca-windows-setup.exe) · [Linux AppImage](https://github.com/stablyai/orca/releases/latest/download/orca-linux.AppImage) · [전체 빌드](https://github.com/stablyai/orca/releases/latest)

_또는 패키지 매니저로 설치:_

```bash
# macOS (Homebrew)
brew install --cask stablyai/orca/orca

# Arch Linux (AUR) — or stably-orca-git to build from source
yay -S stably-orca-bin
```

### 모바일 Companion — iOS, Android

데스크톱 앱과 페어링해 휴대폰에서 에이전트를 모니터링하고 조종하세요.

- **iOS:** [App Store에서 다운로드](https://apps.apple.com/us/app/orca-ide/id6766130217)
- **Android:** [APK 다운로드](https://github.com/stablyai/orca/releases/download/mobile-android-v0.0.26/app-release.apk)

---

## 커뮤니티와 지원

- **Discord:** **[Discord](https://discord.gg/fzjDKHxv8Q)** 커뮤니티에 참여하세요.
- **Twitter / X:** 업데이트와 공지는 **[@orca_build](https://x.com/orca_build)** 를 팔로우하세요.
- **피드백과 아이디어:** 우리는 빠르게 출시합니다. 필요한 기능이 있나요? [새 기능을 요청](https://github.com/stablyai/orca/issues)하세요.
- **개인정보 보호:** Orca가 수집하는 익명 사용 데이터와 수집 거부 방법은 [개인정보 및 텔레메트리 문서](https://www.onorca.dev/docs/telemetry)를 참고하세요.
- **응원하기:** 이 리포지토리에 [Star](https://github.com/stablyai/orca)를 눌러 매일의 릴리스를 따라와 주세요.

---

## 개발

기여하거나 로컬에서 실행하고 싶으신가요? [CONTRIBUTING.md](../../.github/CONTRIBUTING.md) 가이드를 확인하세요.

<a href="https://github.com/stablyai/orca/graphs/contributors">
  <img src="https://contrib.rocks/image?repo=stablyai/orca" alt="Orca 기여자" />
</a>

## 라이선스

Orca는 [MIT 라이선스](../../LICENSE)에 따라 자유롭게 사용할 수 있는 오픈 소스입니다.
