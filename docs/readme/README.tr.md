<h1 align="center">
  <a href="https://onOrca.dev"><img src="../../resources/build/icon.png" alt="Orca" width="64" valign="middle" /></a> Orca
</h1>

<p align="center">
  <a href="https://github.com/stablyai/orca"><img src="https://img.shields.io/github/stars/stablyai/orca?style=flat&amp;label=%E2%98%85&amp;color=08C" alt="GitHub stars" /></a>
  <a href="https://github.com/stablyai/orca/releases"><img src="../../docs/assets/readme-downloads.svg" alt="Tüm sürümlerdeki toplam indirme" /></a>
  <img src="https://img.shields.io/badge/license-MIT-08C?style=flat" alt="Lisans: MIT" />
  <a href="https://discord.gg/fzjDKHxv8Q"><img src="https://img.shields.io/badge/Discord-5865F2?logo=discord&logoColor=white" alt="Orca Discord Sunucusuna Katıl" /></a>
  <a href="https://x.com/orca_build"><img src="https://img.shields.io/badge/X-000000?logo=x&logoColor=white" alt="Orca'yı X'te Takip Et" /></a>
  <img src="https://img.shields.io/badge/macOS%20%7C%20Windows%20%7C%20Linux-4493F8?style=flat-square" alt="Desteklenen platformlar: macOS, Windows ve Linux" />
</p>

<p align="center">
  <sub><a href="../../README.md">English</a> · <a href="README.tr.md">Türkçe</a> · <a href="README.zh-CN.md">中文</a> · <a href="README.ja.md">日本語</a> · <a href="README.ko.md">한국어</a> · <a href="README.es.md">Español</a> · <a href="README.fr.md">Français</a> · <a href="README.pt.md">Português</a></sub>
</p>

<p align="center">
  <strong>100x geliştiriciler için Yapay Zekâ Orkestratörü.</strong><br/>
  Codex, Claude Code, OpenCode veya Pi'yi yan yana çalıştırın — her biri kendi git çalışma ağacında (worktree), tek bir yerden takip edilsin.
</p>

<h3 align="center"><a href="https://onorca.dev/download"><ins>Orca'yı İndir</ins></a></h3>

<p align="center">
  <img src="../../docs/assets/readme-hero.jpg" alt="Paralel çalışma ağaçlarında ajan çalıştıran Orca masaüstü uygulaması ve köşede Orca mobil yardımcısı" width="960" />
</p>

## Özellikler

<table>
<tr>
<td width="50%" valign="middle">

### Mobil Yardımcı (Mobile Companion)

Ajanlarınızı telefonunuzdan izleyin ve yönlendirin — bir ajan tamamlandığında bildirim alın ve her yerden takip istemleri gönderin.

[iOS App Store](https://apps.apple.com/us/app/orca-ide/id6766130217) · [TestFlight](https://testflight.apple.com/join/YjeGMQBA) · [Android APK 0.0.37](https://github.com/stablyai/orca/releases/download/mobile-android-v0.0.37/app-release.apk) · [Dokümanlar →](https://www.onorca.dev/docs/mobile)

</td>
<td width="50%">
  <a href="https://www.onorca.dev/docs/mobile"><picture><source srcset="../../docs/assets/feature-wall/mobile-companion-app-showcase.gif" type="image/gif"><img src="../../docs/assets/feature-wall/mobile-companion-app-showcase.jpg" alt="Orca masaüstü ve mobil yardımcı uygulaması" width="100%" /></picture></a>
</td>
</tr>
<tr>
<td width="50%" valign="middle">

### Paralel Çalışma Ağaçları (Parallel Worktrees)

Tek bir istemi beş farklı ajana yayınlayın; her biri kendi izole git çalışma ağacında (worktree) çalışsın — sonuçları karşılaştırın ve kazananı ana dala birleştirin.

[Dokümanlar →](https://www.onorca.dev/docs/model/worktrees)

</td>
<td width="50%">
  <a href="https://www.onorca.dev/docs/model/worktrees"><picture><source srcset="../../docs/assets/feature-wall/parallel-worktrees.gif" type="image/gif"><img src="../../docs/assets/feature-wall/parallel-worktrees.jpg" alt="Paralel çalışma ağacı orkestrasyonu" width="100%" /></picture></a>
</td>
</tr>
<tr>
<td width="50%" valign="middle">

### Terminal Bölünmeleri (Terminal Splits)

WebGL işleme, sonsuz bölünme ve yeniden başlatmalarda kaybolmayan kaydırma geçmişine sahip Ghostty sınıfı terminaller.

[Dokümanlar →](https://www.onorca.dev/docs/terminal)

</td>
<td width="50%">
  <a href="https://www.onorca.dev/docs/terminal"><picture><source srcset="../../docs/assets/feature-wall/terminal-splits.gif" type="image/gif"><img src="../../docs/assets/feature-wall/terminal-splits.jpg" alt="Terminal bölünmeleri" width="100%" /></picture></a>
</td>
</tr>
<tr>
<td width="50%" valign="middle">

### Tasarım Modu (Design Mode)

HTML, CSS ve kırpılmış ekran görüntüsünü doğrudan ajanın istemine göndermek için gerçek bir Chromium penceresindeki herhangi bir kullanıcı arayüzü öğesine tıklayın.

[Dokümanlar →](https://www.onorca.dev/docs/browser/design-mode)

</td>
<td width="50%">
  <a href="https://www.onorca.dev/docs/browser/design-mode"><picture><source srcset="../../docs/assets/feature-wall/design-mode.gif" type="image/gif"><img src="../../docs/assets/feature-wall/design-mode.jpg" alt="Gömülü tarayıcı ve Tasarım Modu" width="100%" /></picture></a>
</td>
</tr>
<tr>
<td width="50%" valign="middle">

### Yerel GitHub &amp; Linear Entegrasyonu

PR'ları, sorunları ve proje panolarını uygulama içinde inceleyin — herhangi bir görevden çalışma ağacı açın ve bağlam değiştirmeden kod incelemesi yapın.

[Dokümanlar →](https://www.onorca.dev/docs/review/linear)

</td>
<td width="50%">
  <a href="https://www.onorca.dev/docs/review/linear"><picture><source srcset="../../docs/assets/feature-wall/github-linear.gif" type="image/gif"><img src="../../docs/assets/feature-wall/github-linear.jpg" alt="Orca içinde GitHub ve Linear görev akışları" width="100%" /></picture></a>
</td>
</tr>
<tr>
<td width="50%" valign="middle">

### SSH Çalışma Ağaçları

Ajanları tam dosya düzenleme, git ve terminallerle güçlü bir uzak sunucuda çalıştırın — otomatik yeniden bağlanma ve port yönlendirme dahildir.

[Dokümanlar →](https://www.onorca.dev/docs/ssh)

</td>
<td width="50%">
  <a href="https://www.onorca.dev/docs/ssh"><picture><source srcset="../../docs/assets/feature-wall/ssh-worktrees.gif" type="image/gif"><img src="../../docs/assets/feature-wall/ssh-worktrees.jpg" alt="SSH üzerinden uzak çalışma ağaçları" width="100%" /></picture></a>
</td>
</tr>
<tr>
<td width="50%" valign="middle">

### Yapay Zekâ Farklarına Not Ekleme (Annotate AI Diffs)

Herhangi bir fark (diff) satırına yorum bırakın ve bunları ajana geri gönderin — Orca'dan ayrılmadan inceleyin, düzenleyin ve işleyin (commit).

[Dokümanlar →](https://www.onorca.dev/docs/review/annotate-ai-diff)

</td>
<td width="50%">
  <a href="https://www.onorca.dev/docs/review/annotate-ai-diff"><picture><source srcset="../../docs/assets/feature-wall/annotate-diff.gif" type="image/gif"><img src="../../docs/assets/feature-wall/annotate-diff.jpg" alt="Yapay zekâ tarafından oluşturulan farklara not ekleme" width="100%" /></picture></a>
</td>
</tr>
<tr>
<td width="50%" valign="middle">

### Dosyaları Ajanlara Sürükleyin

VS Code'un her yerde otomatik kaydetme özelliğine sahip düzenleyicisi — dosyaları veya görselleri doğrudan ajan istemine sürükleyin.

[Dokümanlar →](https://www.onorca.dev/docs/editing/file-explorer)

</td>
<td width="50%">
  <a href="https://www.onorca.dev/docs/editing/file-explorer"><picture><source srcset="../../docs/assets/feature-wall/file-drag.gif" type="image/gif"><img src="../../docs/assets/feature-wall/file-drag.jpg" alt="Dosya ve görselleri ajan istemine sürükleme" width="100%" /></picture></a>
</td>
</tr>
<tr>
<td width="50%" valign="middle">

### Orca CLI

Ajanlar da Orca'yı yönlendirir — `orca worktree create`, `snapshot`, `click` ve `fill` komutları ile tüm iş akışlarınızı kodlayın.

[Dokümanlar →](https://www.onorca.dev/docs/cli/overview)

</td>
<td width="50%">
  <a href="https://www.onorca.dev/docs/cli/overview"><picture><source srcset="../../docs/assets/feature-wall/orca-cli.gif" type="image/gif"><img src="../../docs/assets/feature-wall/orca-cli.jpg" alt="Orca'yı CLI üzerinden komutlandırma" width="100%" /></picture></a>
</td>
</tr>
</table>

**Ayrıca kutunun içinde:**

- **[Hızlı açılış (Quick open)](https://www.onorca.dev/docs/model/quick-open)** — Odaklanmanızı bozmadan çalışma ağaçlarında, dosyalarda, ajanlarda, komutlarda ve depo bağlamında arama yapın.
- **[Hesap değiştirici &amp; kullanım takibi](https://www.onorca.dev/docs/agents/usage-tracking)** — Claude ve Codex kullanım oranlarını ve oran sınırı sıfırlamalarını görün, yeniden giriş yapmadan hızlıca hesap değiştirin.
- **[Zengin depo önizlemeleri](https://www.onorca.dev/docs/editing/markdown)** — Çalışma alanında Markdown, görseller, PDF'ler ve depo dökümanlarını önizleyin.
- **[Bilgisayar Kullanımı (Computer Use)](https://www.onorca.dev/docs/cli/computer-use)** — Bir iş akışı gerçek etkileşim gerektirdiğinde ajanların masaüstü uygulamalarını ve görünür arayüzleri işletmesine izin verin.
- **[Bildirimler ve okunmamış durumlar](https://www.onorca.dev/docs/notifications)** — Bir ajanın ne zaman bittiğini veya dikkatinizi gerektirdiğini bilin, daha sonra dönmek için başlıkları okunmadı olarak işaretleyin.
- **Ve çok daha fazlası** — her gün yeni sürümler çıkarıyoruz, bu yüzden bu liste sürekli güncellenir. Gerçek özellik listesi için [değişiklik günlüğünü (changelog)](https://github.com/stablyai/orca/releases) inceleyebilirsiniz.

---

## Desteklenen Ajanlar

**Herhangi bir CLI ajanı** ile çalışır — bir terminalde çalışıyorsa, Orca'da da çalışır.

<p>
  <a href="https://docs.anthropic.com/claude/docs/claude-code"><kbd><img src="../../docs/assets/claude-logo.svg" alt="Claude Code logosu" width="16" valign="middle" /> Claude Code</kbd></a> &nbsp;
  <a href="https://github.com/openai/codex"><kbd><img src="https://www.google.com/s2/favicons?domain=openai.com&sz=64" alt="Codex logosu" width="16" valign="middle" /> Codex</kbd></a> &nbsp;
  <a href="https://x.ai/cli"><kbd><img src="https://www.google.com/s2/favicons?domain=x.ai&sz=64" alt="Grok logosu" width="16" valign="middle" /> Grok</kbd></a> &nbsp;
  <a href="https://cursor.com/cli"><kbd><img src="https://www.google.com/s2/favicons?domain=cursor.com&sz=64" alt="Cursor logosu" width="16" valign="middle" /> Cursor</kbd></a> &nbsp;
  <a href="https://docs.github.com/en/copilot/how-tos/set-up/install-copilot-cli"><kbd><img src="https://www.google.com/s2/favicons?domain=github.com&sz=64" alt="GitHub Copilot logosu" width="16" valign="middle" /> GitHub Copilot</kbd></a> &nbsp;
  <a href="https://opencode.ai/docs/cli/"><kbd><img src="https://www.google.com/s2/favicons?domain=opencode.ai&sz=64" alt="OpenCode logosu" width="16" valign="middle" /> OpenCode</kbd></a> &nbsp;
  <a href="https://mimo.xiaomi.com/coder"><kbd><img src="https://www.google.com/s2/favicons?domain=mimo.xiaomi.com&sz=64" alt="MiMo Code logosu" width="16" valign="middle" /> MiMo Code</kbd></a> &nbsp;
  <a href="https://ampcode.com/manual#install"><kbd><img src="https://www.google.com/s2/favicons?domain=ampcode.com&sz=64" alt="Amp logosu" width="16" valign="middle" /> Amp</kbd></a> &nbsp;
  <a href="https://openclaude.gitlawb.com/"><kbd><img src="../../resources/openclaude-logo.png" alt="OpenClaude logosu" width="16" valign="middle" /> OpenClaude</kbd></a> &nbsp;
  <a href="https://antigravity.google/docs/cli-overview"><kbd><img src="https://www.google.com/s2/favicons?domain=antigravity.google&sz=64" alt="Antigravity logosu" width="16" valign="middle" /> Antigravity</kbd></a> &nbsp;
  <a href="https://pi.dev"><kbd><img src="https://pi.dev/favicon.svg" alt="Pi logosu" width="16" valign="middle" /> Pi</kbd></a> &nbsp;
  <a href="https://omp.sh"><kbd><img src="https://omp.sh/favicon.svg" alt="oh-my-pi logosu" width="16" valign="middle" /> oh-my-pi</kbd></a> &nbsp;
  <a href="https://hermes-agent.nousresearch.com/docs/"><kbd><img src="https://www.google.com/s2/favicons?domain=nousresearch.com&sz=64" alt="Hermes Agent logosu" width="16" valign="middle" /> Hermes Agent</kbd></a> &nbsp;
  <a href="https://devin.ai/cli"><kbd><img src="https://www.google.com/s2/favicons?domain=devin.ai&sz=64" alt="Devin logosu" width="16" valign="middle" /> Devin</kbd></a> &nbsp;
  <a href="https://block.github.io/goose/docs/quickstart/"><kbd><img src="https://www.google.com/s2/favicons?domain=goose-docs.ai&sz=64" alt="Goose logosu" width="16" valign="middle" /> Goose</kbd></a> &nbsp;
  <a href="https://docs.augmentcode.com/cli/overview"><kbd><img src="https://www.google.com/s2/favicons?domain=augmentcode.com&sz=64" alt="Auggie logosu" width="16" valign="middle" /> Auggie</kbd></a> &nbsp;
  <a href="https://github.com/autohandai/code-cli"><kbd><img src="https://www.google.com/s2/favicons?domain=autohand.ai&sz=64" alt="Autohand Code logosu" width="16" valign="middle" /> Autohand Code</kbd></a> &nbsp;
  <a href="https://github.com/charmbracelet/crush"><kbd><img src="https://www.google.com/s2/favicons?domain=charm.sh&sz=64" alt="Charm logosu" width="16" valign="middle" /> Charm</kbd></a> &nbsp;
  <a href="https://docs.cline.bot/cline-cli/overview"><kbd><img src="https://www.google.com/s2/favicons?domain=cline.bot&sz=64" alt="Cline logosu" width="16" valign="middle" /> Cline</kbd></a> &nbsp;
  <a href="https://www.codebuff.com/docs/help/quick-start"><kbd><img src="https://www.google.com/s2/favicons?domain=codebuff.com&sz=64" alt="Codebuff logosu" width="16" valign="middle" /> Codebuff</kbd></a> &nbsp;
  <a href="https://commandcode.ai/docs/quickstart"><kbd><img src="https://www.google.com/s2/favicons?domain=commandcode.ai&sz=64" alt="Command Code logosu" width="16" valign="middle" /> Command Code</kbd></a> &nbsp;
  <a href="https://docs.continue.dev/guides/cli"><kbd><img src="https://www.google.com/s2/favicons?domain=continue.dev&sz=64" alt="Continue logosu" width="16" valign="middle" /> Continue</kbd></a> &nbsp;
  <a href="https://docs.factory.ai/cli/getting-started/quickstart"><kbd><img src="../../docs/assets/droid-logo.svg" alt="Droid logosu" width="16" valign="middle" /> Droid</kbd></a> &nbsp;
  <a href="https://kilo.ai/docs/cli"><kbd><img src="https://raw.githubusercontent.com/Kilo-Org/kilocode/main/packages/kilo-vscode/assets/icons/kilo-light.svg" alt="Kilocode logosu" width="16" valign="middle" /> Kilocode</kbd></a> &nbsp;
  <a href="https://www.kimi.com/code/docs/en/kimi-code-cli/getting-started.html"><kbd><img src="https://www.google.com/s2/favicons?domain=moonshot.cn&sz=64" alt="Kimi logosu" width="16" valign="middle" /> Kimi</kbd></a> &nbsp;
  <a href="https://kiro.dev/docs/cli/"><kbd><img src="https://www.google.com/s2/favicons?domain=kiro.dev&sz=64" alt="Kiro logosu" width="16" valign="middle" /> Kiro</kbd></a> &nbsp;
  <a href="https://github.com/mistralai/mistral-vibe"><kbd><img src="https://www.google.com/s2/favicons?domain=mistral.ai&sz=64" alt="Mistral Vibe logosu" width="16" valign="middle" /> Mistral Vibe</kbd></a> &nbsp;
  <a href="https://github.com/QwenLM/qwen-code"><kbd><img src="https://www.google.com/s2/favicons?domain=qwenlm.github.io&sz=64" alt="Qwen Code logosu" width="16" valign="middle" /> Qwen Code</kbd></a> &nbsp;
  <a href="https://support.atlassian.com/rovo/docs/install-and-run-rovo-dev-cli-on-your-device/"><kbd><img src="https://www.google.com/s2/favicons?domain=atlassian.com&sz=64" alt="Rovo Dev logosu" width="16" valign="middle" /> Rovo Dev</kbd></a> &nbsp;
  <kbd>+ herhangi bir CLI ajanı</kbd>
</p>

---

## Kurulum

### Masaüstü — macOS, Windows, Linux

- **[onOrca.dev Üzerinden İndir](https://onorca.dev/download)**
- Veya doğrudan bir sürüm edinin: [macOS Apple Silicon](https://github.com/stablyai/orca/releases/latest/download/orca-macos-arm64.dmg) · [macOS Intel](https://github.com/stablyai/orca/releases/latest/download/orca-macos-x64.dmg) · [Windows (.exe)](https://github.com/stablyai/orca/releases/latest/download/orca-windows-setup.exe) · [Linux AppImage](https://github.com/stablyai/orca/releases/latest/download/orca-linux.AppImage) · [Tüm Sürümler](https://github.com/stablyai/orca/releases/latest)
- Grafik arayüzsüz (headless) bir Linux sunucusunda `orca serve` mü çalıştırıyorsunuz? [Headless Linux sunucu rehberine](../../docs/reference/headless-linux-server.md) göz atın.

_Veya bir paket yöneticisi aracılığıyla:_

```bash
# macOS (Homebrew)
brew install --cask stablyai/orca/orca

# Arch Linux (AUR) — veya kaynaktan derlemek için stably-orca-git
yay -S stably-orca-bin
```

### Mobil Yardımcı — iOS, Android

Ajanlarınızı telefonunuzdan izlemek ve yönlendirmek için masaüstü uygulamanızla eşleştirin.

- **iOS:** [App Store'dan İndir](https://apps.apple.com/us/app/orca-ide/id6766130217) veya [TestFlight'a Katıl](https://testflight.apple.com/join/YjeGMQBA)
- **Android:** [APK 0.0.37 İndir](https://github.com/stablyai/orca/releases/download/mobile-android-v0.0.37/app-release.apk)

---

## Topluluk &amp; Destek

- **Discord:** **[Discord](https://discord.gg/fzjDKHxv8Q)** topluluğumuza katılın.
- **Twitter / X:** Güncellemeler ve duyurular için **[@orca_build](https://x.com/orca_build)** hesabını takip edin.
- **WeChat:** Orca topluluğu WeChat 7. grubuna katılmak için taratın.

  <img src="../../docs/assets/wechat-qr-group7.jpg" alt="Orca topluluğu için WeChat grup 7 QR kodu" width="160" />

- **Geri Bildirim &amp; Fikirler:** Hızlı yayınlar çıkarıyoruz. Eksik bir şey mi var? [Yeni bir özellik talep edin](https://github.com/stablyai/orca/issues).
- **Gizlilik:** Orca'nın hangi anonim kullanım verilerini topladığını ve nasıl devre dışı bırakılacağını öğrenmek için [gizlilik &amp; telemetri dokümanlarına](https://www.onorca.dev/docs/telemetry) bakın.
- **Destek Olun:** Günlük yayınlarımızı takip etmek için bu depoya bir [Yıldız (Star)](https://github.com/stablyai/orca) verin.

---

## Geliştirme

Katkıda bulunmak veya yerel olarak çalıştırmak mı istiyorsunuz? [CONTRIBUTING.md](../../.github/CONTRIBUTING.md) rehberimizi inceleyin.

<a href="https://github.com/stablyai/orca/graphs/contributors">
  <img src="https://contrib.rocks/image?repo=stablyai/orca" alt="Orca katkıda bulunanları" />
</a>

<p align="center">
  <img src="../../docs/assets/star-history.png" alt="stablyai/orca için GitHub yıldız geçmişi grafiği" width="880" />
</p>

## İmzalı Sürümler
Windows kod imzalama sponsorluğu [SignPath.io](https://signpath.io) tarafından sağlanmaktadır, sertifika [SignPath Foundation](https://signpath.org) tarafından verilmiştir.

## Lisans

Orca, [MIT Lisansı](../../LICENSE) kapsamında ücretsiz ve açık kaynaklıdır.
