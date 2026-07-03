<h1 align="center">
  <a href="https://onOrca.dev"><img src="../../resources/build/icon.png" alt="Orca" width="64" valign="middle" /></a> Orca
</h1>

<p align="center">
  <a href="https://github.com/stablyai/orca/stargazers"><img src="https://badgen.net/github/stars/stablyai/orca?label=%E2%98%85" alt="GitHub yıldızları" /></a>
  <a href="https://github.com/stablyai/orca/releases"><img src="../assets/readme-downloads.svg" alt="Tüm sürümlerde toplam indirme" /></a>
  <img src="https://badgen.net/github/license/stablyai/orca" alt="Lisans" />
  <a href="https://discord.gg/fzjDKHxv8Q"><img src="https://img.shields.io/badge/Discord-5865F2?logo=discord&logoColor=white" alt="Orca Discord sunucusuna katıl" /></a>
  <a href="https://x.com/orca_build"><img src="https://img.shields.io/badge/X-000000?logo=x&logoColor=white" alt="X'te Orca'yı takip et" /></a>
  <img src="https://img.shields.io/badge/macOS%20%7C%20Windows%20%7C%20Linux-4493F8?style=flat-square" alt="Desteklenen platformlar: macOS, Windows ve Linux" />
</p>

<p align="center">
  <sub><a href="../../README.md">English</a> · <a href="README.zh-CN.md">中文</a> · <a href="README.ja.md">日本語</a> · <a href="README.ko.md">한국어</a> · <a href="README.tr.md">Türkçe</a></sub>
</p>

<p align="center">
  <strong>100x geliştiriciler için yapay zeka orkestrasyon aracı.</strong><br/>
  Claude Code, OpenClaude, Codex ya da OpenCode'u yan yana çalıştırın — her biri kendi worktree'sinde, hepsi tek bir yerden yönetilsin.
</p>

<h3 align="center"><a href="https://onorca.dev/download"><ins>Orca'yı İndirin</ins></a></h3>

<p align="center">
  <img src="../assets/readme-hero.jpg" alt="Orca masaüstü uygulaması, paralel worktree'lerde agent'ları çalıştırırken köşede Orca mobil uygulaması" width="960" />
</p>

## Özellikler

<table>
<tr>
<td width="50%" valign="middle">

### Mobil Uygulama

Agent'larınızı telefonunuzdan izleyin ve yönlendirin — bir agent işini bitirdiğinde bildirim alın, istediğiniz yerden yeni talimatlar gönderin.

[App Store de iOS](https://apps.apple.com/us/app/orca-ide/id6766130217) · [APK para Android](https://github.com/stablyai/orca/releases/download/mobile-android-v0.0.18/app-release.apk) · [Belgeler →](https://www.onorca.dev/docs/mobile)

</td>
<td width="50%">
  <a href="https://www.onorca.dev/docs/mobile"><picture><source srcset="../assets/feature-wall/mobile-companion-app-showcase.gif" type="image/gif"><img src="../assets/feature-wall/mobile-companion-app-showcase.jpg" alt="Orca de escritorio con la app companion móvil" width="100%" /></picture></a>
</td>
</tr>
<tr>
<td width="50%" valign="middle">

### Paralel Worktree

Tek bir komutu beş farklı agent'a gönderin, her biri kendi yalıtılmış git worktree'sinde çalışsın — sonuçları karşılaştırın, en iyisini merge'leyin.

[Belgeler →](https://www.onorca.dev/docs/model/worktrees)

</td>
<td width="50%">
  <a href="https://www.onorca.dev/docs/model/worktrees"><picture><source srcset="../assets/feature-wall/parallel-worktrees.gif" type="image/gif"><img src="../assets/feature-wall/parallel-worktrees.jpg" alt="Paralel worktree orkestrasyonu" width="100%" /></picture></a>
</td>
</tr>
<tr>
<td width="50%" valign="middle">

### Bölünmüş Terminal

Ghostty seviyesinde terminaller: WebGL render, sınırsız bölme ve yeniden başlatsanız bile kaybolmayan scrollback geçmişi.

[Belgeler →](https://www.onorca.dev/docs/terminal)

</td>
<td width="50%">
  <a href="https://www.onorca.dev/docs/terminal"><picture><source srcset="../assets/feature-wall/terminal-splits.gif" type="image/gif"><img src="../assets/feature-wall/terminal-splits.jpg" alt="Terminales divididas" width="100%" /></picture></a>
</td>
</tr>
<tr>
<td width="50%" valign="middle">

### Tasarım Modu

Gerçek bir Chromium penceresindeki herhangi bir UI öğesine tıklayın — HTML'i, CSS'i ve kırpılmış ekran görüntüsü doğrudan agent'ınızın komut satırına gönderilsin.

[Belgeler →](https://www.onorca.dev/docs/browser/design-mode)

</td>
<td width="50%">
  <a href="https://www.onorca.dev/docs/browser/design-mode"><picture><source srcset="../assets/feature-wall/design-mode.gif" type="image/gif"><img src="../assets/feature-wall/design-mode.jpg" alt="Yerleşik tarayıcı ve tasarım modu" width="100%" /></picture></a>
</td>
</tr>
<tr>
<td width="50%" valign="middle">

### GitHub ve Linear, Doğrudan Uygulama İçinde

PR'ları, issue'ları ve proje panolarını uygulamanın içinde keşfedin — herhangi bir görevden worktree açın, bağlam değiştirmeden kod incelemesi yapın.

[Belgeler →](https://www.onorca.dev/docs/review/linear)

</td>
<td width="50%">
  <a href="https://www.onorca.dev/docs/review/linear"><picture><source srcset="../assets/feature-wall/github-linear.gif" type="image/gif"><img src="../assets/feature-wall/github-linear.jpg" alt="Orca'da GitHub ve Linear iş akışları" width="100%" /></picture></a>
</td>
</tr>
<tr>
<td width="50%" valign="middle">

### SSH ile Worktree

Güçlü bir uzak makinede agent'ları çalıştırın — tam dosya düzenleme, git ve terminallerle birlikte, otomatik yeniden bağlanma ve port yönlendirme dahil.

[Belgeler →](https://www.onorca.dev/docs/ssh)

</td>
<td width="50%">
  <a href="https://www.onorca.dev/docs/ssh"><picture><source srcset="../assets/feature-wall/ssh-worktrees.gif" type="image/gif"><img src="../assets/feature-wall/ssh-worktrees.jpg" alt="SSH ile uzak worktree'ler" width="100%" /></picture></a>
</td>
</tr>
<tr>
<td width="50%" valign="middle">

### Yapay Zeka Diff'lerini İnceleme

Diff'in herhangi bir satırına yorum bırakın ve agent'ınıza geri gönderin — Orca'dan çıkmadan inceleyin, düzenleyin ve commit'leyin.

[Belgeler →](https://www.onorca.dev/docs/review/annotate-ai-diff)

</td>
<td width="50%">
  <a href="https://www.onorca.dev/docs/review/annotate-ai-diff"><picture><source srcset="../assets/feature-wall/annotate-diff.gif" type="image/gif"><img src="../assets/feature-wall/annotate-diff.jpg" alt="Yapay zeka tarafından oluşturulan diff'leri inceleme" width="100%" /></picture></a>
</td>
</tr>
<tr>
<td width="50%" valign="middle">

### Agent'a Dosya Sürükleme

Her yerde otomatik kaydeden VS Code editörü — dosyaları ya da görselleri doğrudan agent'ın komut satırına sürükleyin.

[Belgeler →](https://www.onorca.dev/docs/editing/file-explorer)

</td>
<td width="50%">
  <a href="https://www.onorca.dev/docs/editing/file-explorer"><picture><source srcset="../assets/feature-wall/file-drag.gif" type="image/gif"><img src="../assets/feature-wall/file-drag.jpg" alt="Agent'ın komut satırına dosya ve görsel sürükleme" width="100%" /></picture></a>
</td>
</tr>
<tr>
<td width="50%" valign="middle">

### Orca CLI

Agent'lar aynı zamanda Orca'yı da yönetir — herhangi bir iş akışını otomatikleştirin con `orca worktree create`, `snapshot`, `click` y `fill`.

[Belgeler →](https://www.onorca.dev/docs/cli/overview)

</td>
<td width="50%">
  <a href="https://www.onorca.dev/docs/cli/overview"><picture><source srcset="../assets/feature-wall/orca-cli.gif" type="image/gif"><img src="../assets/feature-wall/orca-cli.jpg" alt="Orca'yı CLI'dan otomatikleştirin" width="100%" /></picture></a>
</td>
</tr>
</table>

**Ayrıca şunları da içerir:**

- **[Hızlı Açma](https://www.onorca.dev/docs/model/quick-open)** — Worktree, dosya, agent, komut ve repo bağlamı arasında iş akışınızdan çıkmadan arama yapın.
- **[Hesap Değiştirme ve Kullanım Takibi](https://www.onorca.dev/docs/agents/usage-tracking)** — Claude ve Codex kullanımını, limit sıfırlanmalarını görüntüleyin ve yeniden giriş yapmadan anında hesap değiştirin.
- **[Zengin Repo Önizlemeleri](https://www.onorca.dev/docs/editing/markdown)** — Markdown, görsel, PDF ve repo dökümanlarını workspace içinde önizleyin.
- **[Computer Use](https://www.onorca.dev/docs/cli/computer-use)** — Agent'ların, bir iş akışı gerçek etkileşim gerektirdiğinde masaüstü uygulamalarını ve görünür UI'ı yönetmesine izin verin.
- **[Bildirimler ve Okunmamış Durumu](https://www.onorca.dev/docs/notifications)** — Bir agent tamamlandığında veya dikkatinizi gerektirdiğinde haberdar olun, konuları daha sonra dönmek için okunmamış olarak işaretleyin.
- **Ve çok daha fazlası** — her gün yeni özellik çıkarıyoruz, bu yüzden bu liste her zaman güncel değil. El [changelog](https://github.com/stablyai/orca/releases) es la verdadera lista de funciones.

---

## Desteklenen Agent'lar

Funciona con **cualquier agente CLI** — si corre en una terminal, corre en Orca.

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
  <kbd>+ herhangi bir CLI agent'ı</kbd>
</p>

---

## Kurulum

### Masaüstü — macOS, Windows, Linux

- **[onOrca.dev'den indirin](https://onorca.dev/download)**
- Ya da doğrudan bir sürüm seçin: [macOS Apple Silicon](https://github.com/stablyai/orca/releases/latest/download/orca-macos-arm64.dmg) · [macOS Intel](https://github.com/stablyai/orca/releases/latest/download/orca-macos-x64.dmg) · [Windows (.exe)](https://github.com/stablyai/orca/releases/latest/download/orca-windows-setup.exe) · [Linux AppImage](https://github.com/stablyai/orca/releases/latest/download/orca-linux.AppImage) · [Tüm sürümler](https://github.com/stablyai/orca/releases/latest)

_Ya da bir paket yöneticisi ile:_

```bash
# macOS (Homebrew)
brew install --cask stablyai/orca/orca

# Arch Linux (AUR) — ya da kaynaktan derlemek için stably-orca-git
yay -S stably-orca-bin
```

### Mobil Uygulama — iOS, Android

Agent'larınızı telefonunuzdan izlemek ve yönlendirmek için masaüstü uygulamanızla eşleştirin.

- **iOS:** [App Store'dan indirin](https://apps.apple.com/us/app/orca-ide/id6766130217)
- **Android:** [APK 0.0.21'i indirin](https://github.com/stablyai/orca/releases/download/mobile-android-v0.0.18/app-release.apk)

---

## Topluluk ve Destek

- **Discord:** **[Discord](https://discord.gg/fzjDKHxv8Q)** sunucumuzda topluluğa katılın.
- **Twitter / X:** Güncellemeler ve duyurular için **[@orca_build](https://x.com/orca_build)** hesabını takip edin.
- **Geri Bildirim ve Fikirler:** Hızlı sürüm çıkarıyoruz. Bir şey mi eksik? [Yeni bir özellik talep edin](https://github.com/stablyai/orca/issues).
- **Gizlilik:** Orca'nın hangi anonim kullanım verilerini topladığını ve nasıl devre dışı bırakacağınızı [gizlilik ve telemetri sayfasından](https://www.onorca.dev/docs/telemetry) öğrenin.
- **Destek Olun:** Günlük sürümlerimizi takip etmek için bu repoya [yıldız](https://github.com/stablyai/orca) verin.

---

## Geliştirme

Katkıda bulunmak ya da yerel ortamınızda çalıştırmak mı istiyorsunuz? [CONTRIBUTING.md](../../.github/CONTRIBUTING.md) rehberine göz atın.

<a href="https://github.com/stablyai/orca/graphs/contributors">
  <img src="https://contrib.rocks/image?repo=stablyai/orca" alt="Orca katkıda bulunanlar" />
</a>

## Lisans

Orca, [MIT Lisansı](../../LICENSE) altında ücretsiz ve açık kaynaklıdır.
