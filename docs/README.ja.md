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

## [新機能] AI Diff への注釈

**AI が生成した Diff に直接コメントできます。**

AI が生成した Diff の任意の行にフィードバックを付け、そのままエージェントに返して修正させましょう。レビューのループを素早く保てます — 行番号をコピーする必要も、コンテキストを切り替える必要もありません。

<p align="center">
  <img src="assets/annotate-ai-diff.gif" alt="Orca AI Diff 注釈 — AI が生成した Diff にコメントしてエージェントにフィードバックを送信" width="800" />
</p>

---

## [新機能] Codex アカウントのホットスワップ

**複数の Codex アカウントをお持ちですか？ワンクリックで切り替えできます。**

最適なトークン条件を得るために複数の Codex アカウントを使っている場合、Orca なら再ログインも設定ファイルの編集も不要で、すぐにアカウントをホットスワップできます。アカウントを選んで、そのまま開発を続けられます。

<p align="center">
  <img src="assets/codex-account-switcher.gif" alt="Orca Codex アカウント切り替え — 複数の Codex アカウント間でホットスワップ" width="800" />
</p>

---

## [新機能] ワークツリーごとのブラウザとデザインモード

**アプリを表示。任意の要素をクリック。チャットにそのまま投入。**

Orca には、ワークツリー内で使える組み込みブラウザがあります。アプリを作りながらプレビューし、デザインモードに切り替えると、任意の UI 要素をクリックするだけで AI チャットにコンテキストとして直接入ります。スクリーンショットもセレクターのコピーも不要です。変更したい箇所を指して、エージェントに指示するだけです。

<p align="center">
  <img src="assets/orca-design-mode.gif" alt="Orca デザインモード — 任意の UI 要素をクリックしてチャットに投入" width="800" />
</p>

---

## [新機能] Orca CLI の紹介

**ターミナルからのエージェントオーケストレーション。**

AI エージェントに IDE を制御させましょう。AI を使って IDE にプロジェクトを追加し、ワークツリーを立ち上げ、現在のワークツリーのコメントを進捗チェックポイントとしてターミナルから直接更新できます。Orca IDE に同梱されています（設定からインストール）。

```bash
npx skills add https://github.com/stablyai/orca --skill orca-cli
```

---

## コミュニティとサポート

- **Discord:** **[Discord](https://discord.gg/fzjDKHxv8Q)** のコミュニティに参加してください。
- **Twitter / X:** アップデートやお知らせは **[@orca_build](https://x.com/orca_build)** をフォローしてください。
- **フィードバックとアイデア:** 私たちは高速にリリースしています。足りない機能がありますか？[機能リクエストを送信](https://github.com/stablyai/orca/issues) してください。
- **応援する:** 毎日のリリースを追うために、このリポジトリにスターを付けてください。

---

## 開発について

貢献したい、またはローカルで実行したいですか？ [CONTRIBUTING.md](../.github/CONTRIBUTING.md) ガイドをご覧ください。
