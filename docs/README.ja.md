<h1 align="center">
  <a href="https://onOrca.dev"><img src="../resources/build/icon.png" alt="Orca" width="64" valign="middle" /></a> Orca
</h1>

<p align="center">
  <img src="https://img.shields.io/badge/Platform-macOS%20%7C%20Windows%20%7C%20Linux-blue?style=for-the-badge" alt="対応プラットフォーム" />
  <a href="https://discord.gg/fzjDKHxv8Q"><img src="https://img.shields.io/badge/Discord-Join-5865F2?style=for-the-badge&logo=discord&logoColor=white" alt="Discord" /></a>
  <a href="https://x.com/orca_build"><img src="https://img.shields.io/badge/%E2%80%8E-Follow_@orca__build-000000?style=for-the-badge&logo=x&logoColor=white" alt="X でフォロー" /></a>
</p>

<p align="center">
  <a href="../README.md">English</a> · <a href="README.zh-CN.md">中文</a> · <a href="README.ja.md">日本語</a> · <a href="README.es.md">Español</a>
</p>

<p align="center">
  <strong>100x ビルダーのための AI オーケストレーター。</strong><br/>
  Claude Code、Codex、OpenCode をリポジトリをまたいで並行実行 — それぞれを専用のワークツリーで動かし、1 か所で追跡できます。<br/>
  <strong>macOS、Windows、Linux</strong> で利用できます。
</p>

<p align="center">
  <a href="#インストール"><strong>ダウンロード 🐋</strong></a>
</p>

<p align="center">
  <img src="assets/file-drag.gif" alt="Orca Screenshot" width="800" />
</p>

## 対応するエージェント

Orca は任意の CLI エージェントに対応しています（*このリストに限定されません*）。

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

## 機能

- **ログイン不要** — お持ちの Claude Code や Codex サブスクリプションをそのまま利用できます。
- **ワークツリーネイティブ** — 各機能は専用のワークツリーで開発できます。スタッシュやブランチ切り替えに悩まず、すぐに作成して切り替えられます。
- **マルチエージェントターミナル** — 複数の AI エージェントをタブやペインで並行実行できます。どれがアクティブかを一目で確認できます。
- **組み込みソース管理** — AI が生成した Diff を確認し、すばやく編集して、Orca から離れずにコミットできます。
- **GitHub 連携** — PR、Issue、Actions チェックが各ワークツリーに自動で紐づきます。
- **SSH サポート** — リモートマシンに接続し、Orca から直接エージェントを実行できます。
- **通知** — エージェントが完了したときや注意が必要なときに通知します。スレッドを未読にして後で戻ることもできます。

---

## インストール

### Mac, Linux, Windows

- **[onOrca.dev からダウンロード](https://onOrca.dev)**
- または **[GitHub Releases ページ](https://github.com/stablyai/orca/releases/latest)** から入手

*パッケージマネージャーからもインストールできます:*

### macOS (Homebrew)

```bash
brew install --cask stablyai/orca/orca
```

### Arch Linux (AUR)

```bash
# ビルド済みバイナリ
yay -S stably-orca-bin

# GitHub ソースからビルド
yay -S stably-orca-git
```

---

## モバイル Companion アプリ

スマートフォンからエージェントを操作できます。

<p align="center">
  <picture><source srcset="assets/feature-wall/mobile-companion-app-showcase.gif" type="image/gif"><img src="assets/feature-wall/mobile-companion-app-showcase.jpg" alt="Orca デスクトップとモバイル companion アプリ" width="720" /></picture>
</p>

- **iOS:** [App Store からダウンロード](https://apps.apple.com/us/app/orca-ide/id6766130217)
- **Android:** [GH release からダウンロード (latest mobile を探してください)](https://github.com/stablyai/orca/releases)

---

## 機能ショーケース

各タイルをクリックすると、そのワークフローを確認できます。

<p align="center">
  <a href="https://www.onorca.dev/docs/model/worktrees"><kbd><strong>並列ワークツリー</strong><br/><br/><picture><source srcset="assets/feature-wall/parallel-worktrees.gif" type="image/gif"><img src="assets/feature-wall/parallel-worktrees.jpg" alt="並列ワークツリーのオーケストレーション" width="390" /></picture><br/></kbd></a> &nbsp;&nbsp;
  <a href="https://www.onorca.dev/docs/terminal"><kbd><strong>ターミナル分割</strong><br/><br/><picture><source srcset="assets/feature-wall/terminal-splits.gif" type="image/gif"><img src="assets/feature-wall/terminal-splits.jpg" alt="Ghostty クラスのターミナル分割" width="390" /></picture><br/></kbd></a><br/><br/>
  <a href="https://www.onorca.dev/docs/browser/design-mode"><kbd><strong>デザインモード</strong><br/><br/><picture><source srcset="assets/feature-wall/design-mode.gif" type="image/gif"><img src="assets/feature-wall/design-mode.jpg" alt="組み込みブラウザとデザインモード" width="390" /></picture><br/></kbd></a> &nbsp;&nbsp;
  <a href="https://www.onorca.dev/docs/review/linear"><kbd><strong>GitHub と Linear をネイティブに</strong><br/><br/><picture><source srcset="assets/feature-wall/github-linear.gif" type="image/gif"><img src="assets/feature-wall/github-linear.jpg" alt="Orca の GitHub と Linear ワークフロー" width="390" /></picture><br/></kbd></a><br/><br/>
  <a href="https://www.onorca.dev/docs/agents/supported"><kbd><strong>任意の CLI エージェント</strong><br/><br/><picture><source srcset="assets/feature-wall/cli-agents.gif" type="image/gif"><img src="assets/feature-wall/cli-agents.jpg" alt="任意の CLI エージェントに対応" width="390" /></picture><br/></kbd></a> &nbsp;&nbsp;
  <a href="https://www.onorca.dev/docs/ssh"><kbd><strong>SSH ワークツリー</strong><br/><br/><picture><source srcset="assets/feature-wall/ssh-worktrees.gif" type="image/gif"><img src="assets/feature-wall/ssh-worktrees.jpg" alt="SSH 経由のリモートワークツリー" width="390" /></picture><br/></kbd></a><br/><br/>
  <a href="https://www.onorca.dev/docs/editing/file-explorer"><kbd><strong>ファイルをエージェントへ</strong><br/><br/><picture><source srcset="assets/feature-wall/file-drag.gif" type="image/gif"><img src="assets/feature-wall/file-drag.jpg" alt="ファイルや画像をエージェントのプロンプトへドラッグ" width="390" /></picture><br/></kbd></a> &nbsp;&nbsp;
  <a href="https://www.onorca.dev/docs/review/annotate-ai-diff"><kbd><strong>AI Diff 注釈</strong><br/><br/><picture><source srcset="assets/feature-wall/annotate-diff.gif" type="image/gif"><img src="assets/feature-wall/annotate-diff.jpg" alt="AI が生成した Diff への注釈" width="390" /></picture><br/></kbd></a><br/><br/>
  <a href="https://www.onorca.dev/docs/cli/overview"><kbd><strong>Orca CLI</strong><br/><br/><picture><source srcset="assets/feature-wall/orca-cli.gif" type="image/gif"><img src="assets/feature-wall/orca-cli.jpg" alt="CLI から Orca をスクリプト操作" width="390" /></picture><br/></kbd></a> &nbsp;&nbsp;
  <a href="https://www.onorca.dev/docs/settings"><kbd><strong>ネイティブ検索</strong><br/><br/><picture><source srcset="assets/feature-wall/keyboard-native.gif" type="image/gif"><img src="assets/feature-wall/keyboard-native.jpg" alt="Orca ワークフロー全体のネイティブ検索" width="390" /></picture><br/></kbd></a><br/><br/>
  <a href="https://www.onorca.dev/docs/agents/usage-tracking"><kbd><strong>アカウント切り替えと使用量トラッキング</strong><br/><br/><picture><source srcset="assets/feature-wall/codex-accounts.gif" type="image/gif"><img src="assets/feature-wall/codex-accounts.jpg" alt="アカウント切り替えと使用量トラッキング" width="390" /></picture><br/></kbd></a> &nbsp;&nbsp;
  <a href="https://www.onorca.dev/docs/editing/markdown"><kbd><strong>リッチなリポジトリプレビュー</strong><br/><br/><picture><source srcset="assets/feature-wall/markdown-editor.gif" type="image/gif"><img src="assets/feature-wall/markdown-editor.jpg" alt="Markdown、画像、PDF、リポジトリ文書のプレビュー" width="390" /></picture><br/></kbd></a><br/><br/>
  <a href="https://www.onorca.dev/docs/model/tabs-panes-splits"><kbd><strong>何でも分割表示</strong><br/><br/><picture><source srcset="assets/feature-wall/split-screen.gif" type="image/gif"><img src="assets/feature-wall/split-screen.jpg" alt="エージェント、ターミナル、ブラウザ、ファイルの分割表示" width="390" /></picture><br/></kbd></a>
</p>

---

## コミュニティとサポート

- **Discord:** **[Discord](https://discord.gg/fzjDKHxv8Q)** のコミュニティに参加してください。
- **Twitter / X:** アップデートやお知らせは **[@orca_build](https://x.com/orca_build)** をフォローしてください。
- **フィードバックとアイデア:** 私たちは高速にリリースしています。足りない機能がありますか？[機能リクエストを送信](https://github.com/stablyai/orca/issues) してください。
- **応援する:** 毎日のリリースを追うために、このリポジトリにスターを付けてください。

---

## 開発について

貢献したい、またはローカルで実行したいですか？ [CONTRIBUTING.md](../.github/CONTRIBUTING.md) ガイドをご覧ください。
