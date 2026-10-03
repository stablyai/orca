<h1 align="center">
  <a href="https://onOrca.dev"><img src="../../resources/build/icon.png" alt="Orca" width="64" valign="middle" /></a> Orca
</h1>

<p align="center">
  <a href="https://github.com/stablyai/orca"><img src="https://img.shields.io/github/stars/stablyai/orca?style=flat&amp;label=%E2%98%85&amp;color=08C" alt="GitHub yıldızları" /></a>
  <a href="https://github.com/stablyai/orca/releases"><img src="../assets/readme-downloads.svg" alt="Tüm sürümlerdeki toplam indirme sayısı" /></a>
  <img src="https://img.shields.io/badge/license-MIT-08C?style=flat" alt="Lisans: MIT" />
  <a href="https://discord.gg/fzjDKHxv8Q"><img src="https://img.shields.io/badge/Discord-5865F2?logo=discord&logoColor=white" alt="Orca Discord sunucusuna katıl" /></a>
  <a href="https://x.com/orca_build"><img src="https://img.shields.io/badge/X-000000?logo=x&logoColor=white" alt="Orca'yı X'te takip et" /></a>
  <img src="https://img.shields.io/badge/macOS%20%7C%20Windows%20%7C%20Linux-4493F8?style=flat-square" alt="Desteklenen platformlar: macOS, Windows ve Linux" />
</p>

<p align="center">
  <sub><a href="../../README.md">English</a> · <a href="README.zh-CN.md">中文</a> · <a href="README.ja.md">日本語</a> · <a href="README.ko.md">한국어</a> · <a href="README.es.md">Español</a> · <a href="README.fr.md">Français</a> · <a href="README.pt.md">Português</a></sub>
</p>

<p align="center">
  <strong>100x geliştiriciler için yapay zekâ orkestratörü.</strong><br/>
  Codex, Claude Code, OpenCode veya Pi'yi yan yana çalıştırın: her biri kendi worktree'sinde, hepsi tek bir yerden takip edilir.
</p>

<h3 align="center"><a href="https://onorca.dev/download"><ins>Orca'yı İndir</ins></a></h3>

<p align="center">
  <img src="../assets/readme-hero.jpg" alt="Paralel worktree'lerde ajanlar çalıştıran Orca masaüstü uygulaması, köşede Orca mobil yardımcı uygulaması" width="960" />
</p>

## Özellikler

<table>
<tr>
<td width="50%" valign="middle">

### Mobil Yardımcı Uygulama

Ajanlarınızı telefonunuzdan izleyin ve yönlendirin: bir ajan işini bitirdiğinde bildirim alın, nerede olursanız olun devam talimatı gönderin.

[iOS App Store](https://apps.apple.com/us/app/orca-ide/id6766130217) · [TestFlight](https://testflight.apple.com/join/YjeGMQBA) · [Android APK 0.0.48](https://github.com/stablyai/orca/releases/download/mobile-android-v0.0.48/app-release.apk) · [Dokümanlar →](https://www.onorca.dev/docs/mobile)

</td>
<td width="50%">
  <a href="https://www.onorca.dev/docs/mobile"><picture><source srcset="../assets/feature-wall/mobile-companion-app-showcase.gif" type="image/gif"><img src="../assets/feature-wall/mobile-companion-app-showcase.jpg" alt="Mobil yardımcı uygulamayla birlikte Orca masaüstü" width="100%" /></picture></a>
</td>
</tr>
<tr>
<td width="50%" valign="middle">

### Paralel Worktree'ler

Tek bir istemi beş ajana dağıtın, her biri kendi izole git worktree'sinde çalışsın; sonuçları karşılaştırın ve kazananı merge edin.

[Dokümanlar →](https://www.onorca.dev/docs/model/worktrees)

</td>
<td width="50%">
  <a href="https://www.onorca.dev/docs/model/worktrees"><picture><source srcset="../site/public/docs/tab-split.gif" type="image/gif"><img src="../site/public/docs/posters/tab-split.jpg" alt="Paralel worktree orkestrasyonu" width="100%" /></picture></a>
</td>
</tr>
<tr>
<td width="50%" valign="middle">

### Terminal Bölmeleri

Ghostty sınıfı terminaller: WebGL ile render, sınırsız bölme ve yeniden başlatmalarda kaybolmayan geçmiş.

[Dokümanlar →](https://www.onorca.dev/docs/terminal)

</td>
<td width="50%">
  <a href="https://www.onorca.dev/docs/terminal"><picture><source srcset="../../resources/onboarding/feature-wall/tile-02.gif" type="image/gif"><img src="../../resources/onboarding/feature-wall/tile-02.poster.jpg" alt="Terminal bölmeleri" width="100%" /></picture></a>
</td>
</tr>
<tr>
<td width="50%" valign="middle">

### Tasarım Modu

Gerçek bir Chromium penceresinde herhangi bir arayüz öğesine tıklayın; HTML'i, CSS'i ve kırpılmış ekran görüntüsü doğrudan ajanınızın istemine gitsin.

[Dokümanlar →](https://www.onorca.dev/docs/browser/design-mode)

</td>
<td width="50%">
  <a href="https://www.onorca.dev/docs/browser/design-mode"><picture><source srcset="../site/public/docs/orca-design-mode.gif" type="image/gif"><img src="../../resources/onboarding/feature-wall/tile-05.poster.jpg" alt="Gömülü tarayıcı ve Tasarım Modu" width="100%" /></picture></a>
</td>
</tr>
<tr>
<td width="50%" valign="middle">

### GitHub ve Linear, Yerleşik

PR'ları, issue'ları ve proje panolarını uygulama içinde gezin; herhangi bir görevden worktree açın ve bağlam değiştirmeden inceleyin.

[Dokümanlar →](https://www.onorca.dev/docs/review/linear)

</td>
<td width="50%">
  <a href="https://www.onorca.dev/docs/review/linear"><picture><source srcset="../../resources/onboarding/feature-wall/tile-03.gif" type="image/gif"><img src="../../resources/onboarding/feature-wall/tile-03.poster.jpg" alt="Orca'da GitHub ve Linear görev akışları" width="100%" /></picture></a>
</td>
</tr>
<tr>
<td width="50%" valign="middle">

### SSH Worktree'leri

Ajanları güçlü bir uzak makinede çalıştırın: tam dosya düzenleme, git ve terminaller, otomatik yeniden bağlanma ve port yönlendirme dahil.

[Dokümanlar →](https://www.onorca.dev/docs/ssh)

</td>
<td width="50%">
  <a href="https://www.onorca.dev/docs/ssh"><picture><source srcset="../../resources/onboarding/feature-wall/tile-06.gif" type="image/gif"><img src="../../resources/onboarding/feature-wall/tile-06.poster.jpg" alt="SSH üzerinden uzak worktree'ler" width="100%" /></picture></a>
</td>
</tr>
<tr>
<td width="50%" valign="middle">

### Yapay Zekâ Diff'lerine Not Düşün

Herhangi bir diff satırına yorum bırakın ve ajana geri gönderin: Orca'dan çıkmadan inceleyin, düzenleyin ve commit'leyin.

[Dokümanlar →](https://www.onorca.dev/docs/review/annotate-ai-diff)

</td>
<td width="50%">
  <a href="https://www.onorca.dev/docs/review/annotate-ai-diff"><picture><source srcset="../site/public/docs/annotate-ai-diff.gif" type="image/gif"><img src="../../resources/onboarding/feature-wall/tile-08.poster.jpg" alt="Yapay zekâ üretimi diff'lere not düşme" width="100%" /></picture></a>
</td>
</tr>
<tr>
<td width="50%" valign="middle">

### Dosyaları Ajanlara Sürükleyin

Her yerde otomatik kayıtlı VS Code editörü: dosyaları veya görselleri doğrudan bir ajan istemine sürükleyin.

[Dokümanlar →](https://www.onorca.dev/docs/editing/file-explorer)

</td>
<td width="50%">
  <a href="https://www.onorca.dev/docs/editing/file-explorer"><picture><source srcset="../../resources/onboarding/feature-wall/tile-07.gif" type="image/gif"><img src="../../resources/onboarding/feature-wall/tile-07.poster.jpg" alt="Dosya ve görselleri ajan istemine sürükleme" width="100%" /></picture></a>
</td>
</tr>
<tr>
<td width="50%" valign="middle">

### Orca CLI

Ajanlar Orca'yı da yönetebilir: `orca worktree create`, `snapshot`, `click` ve `fill` ile her iş akışını betikleştirin.

[Dokümanlar →](https://www.onorca.dev/docs/cli/overview)

</td>
<td width="50%">
  <a href="https://www.onorca.dev/docs/cli/overview"><picture><source srcset="../../resources/onboarding/feature-wall/tile-09.gif" type="image/gif"><img src="../../resources/onboarding/feature-wall/tile-09.poster.jpg" alt="Orca'yı CLI'dan betikleştirme" width="100%" /></picture></a>
</td>
</tr>
</table>

**Kutudan çıkan diğer özellikler:**

- **[Hızlı açma](https://www.onorca.dev/docs/model/quick-open)**: Akışınızdan kopmadan worktree'ler, dosyalar, ajanlar, komutlar ve repo bağlamı arasında arama yapın.
- **[Hesap değiştirici ve kullanım takibi](https://www.onorca.dev/docs/agents/usage-tracking)**: Claude ve Codex kullanımınızı ve limit sıfırlanma zamanlarını görün, yeniden giriş yapmadan hesap değiştirin.
- **[Zengin repo önizlemeleri](https://www.onorca.dev/docs/editing/markdown)**: Markdown, görsel, PDF ve repo dokümanlarını çalışma alanında önizleyin.
- **[Bilgisayar Kullanımı](https://www.onorca.dev/docs/cli/computer-use)**: Bir iş akışı gerçek etkileşim gerektirdiğinde ajanların masaüstü uygulamalarını ve görünür arayüzü kullanmasına izin verin.
- **[Bildirimler ve okunmamış durumu](https://www.onorca.dev/docs/notifications)**: Bir ajan bitirdiğinde veya ilginizi beklediğinde haberdar olun, sonra dönmek için konuları okunmadı olarak işaretleyin.
- **Ve çok, çok daha fazlası**: Her gün yeni sürüm çıkarıyoruz, bu liste hep geride kalıyor. Gerçek özellik listesi [değişiklik günlüğü](https://github.com/stablyai/orca/releases).

---

## Desteklenen Ajanlar

**Her CLI ajanıyla** çalışır: terminalde çalışıyorsa Orca'da da çalışır.

<p>
  <a href="https://docs.anthropic.com/claude/docs/claude-code"><kbd><img src="../assets/claude-logo.svg" alt="Claude Code logosu" width="16" valign="middle" /> Claude Code</kbd></a> &nbsp;
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
  <a href="https://docs.factory.ai/cli/getting-started/quickstart"><kbd><img src="../assets/droid-logo.svg" alt="Droid logosu" width="16" valign="middle" /> Droid</kbd></a> &nbsp;
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

### Masaüstü: macOS, Windows, Linux

- **[onOrca.dev'den indirin](https://onorca.dev/download)**
- Ya da doğrudan bir derleme alın: [macOS Apple Silicon](https://github.com/stablyai/orca/releases/latest/download/orca-macos-arm64.dmg) · [macOS Intel](https://github.com/stablyai/orca/releases/latest/download/orca-macos-x64.dmg) · [Windows (.exe)](https://github.com/stablyai/orca/releases/latest/download/orca-windows-setup.exe) · [Linux AppImage](https://github.com/stablyai/orca/releases/latest/download/orca-linux.AppImage) · [Tüm derlemeler](https://github.com/stablyai/orca/releases/latest)
- Ekransız bir Linux sunucusunda `orca serve` mi çalıştırıyorsunuz? [Ekransız Linux sunucu rehberine](../reference/headless-linux-server.md) bakın.

_Ya da bir paket yöneticisiyle:_

```bash
# macOS (Homebrew)
brew install --cask stablyai/orca/orca

# Arch Linux (AUR), kaynaktan derlemek için stably-orca-git
yay -S stably-orca-bin
```

### Mobil Yardımcı Uygulama: iOS, Android

Masaüstü uygulamanızla eşleştirin, ajanlarınızı telefonunuzdan izleyin ve yönlendirin.

- **iOS:** [App Store'dan indirin](https://apps.apple.com/us/app/orca-ide/id6766130217) veya [TestFlight'a katılın](https://testflight.apple.com/join/YjeGMQBA)
- **Android:** [APK 0.0.48'i indirin](https://github.com/stablyai/orca/releases/download/mobile-android-v0.0.48/app-release.apk) · [Kurulum rehberi](https://www.onorca.dev/docs/android-apk)

---

## Topluluk ve Destek

- **Discord:** Topluluğa **[Discord](https://discord.gg/fzjDKHxv8Q)** üzerinden katılın.
- **Twitter / X:** Güncellemeler ve duyurular için **[@orca_build](https://x.com/orca_build)** hesabını takip edin.
- **WeChat:** Orca topluluğunun 8 numaralı WeChat grubuna katılmak için kodu tarayın. 8. grup dolmuş olabilir; öyleyse 9. grubun QR kodunu tarayın.

  <img src="../assets/wechat-qr-group8.jpg" alt="Orca topluluğu WeChat 8. grup QR kodu" width="160" />&nbsp;&nbsp;<img src="../assets/wechat-qr-group9.jpg" alt="Orca topluluğu WeChat 9. grup QR kodu" width="160" />

- **Geri Bildirim ve Fikirler:** Hızlı geliştiriyoruz. Eksik bir şey mi var? [Yeni özellik isteyin](https://github.com/stablyai/orca/issues).
- **Gizlilik:** Orca'nın hangi anonim kullanım verilerini topladığını ve nasıl kapatacağınızı [gizlilik ve telemetri dokümanlarında](https://www.onorca.dev/docs/telemetry) bulabilirsiniz.
- **Destek Olun:** Günlük sürümlerimizi takip etmek için bu repoya [yıldız verin](https://github.com/stablyai/orca).

---

## Geliştirme

Katkıda bulunmak veya yerelde çalıştırmak mı istiyorsunuz? [CONTRIBUTING.md](../../.github/CONTRIBUTING.md) rehberimize bakın.

Mobil uygulamayı masaüstü ile eşleştiren relay de bu repoda, ayrı bir pnpm çalışma alanı ve kurulum rehberiyle
[`cloud/`](../../cloud/README.md) altında bulunuyor.

<a href="https://github.com/stablyai/orca/graphs/contributors">
  <img src="https://contrib.rocks/image?repo=stablyai/orca" alt="Orca katkıda bulunanları" />
</a>

<p align="center">
  <img src="../assets/star-history.png" alt="stablyai/orca için GitHub yıldız geçmişi grafiği" width="880" />
</p>

## İmzalı Derlemeler

Windows kod imzalama [SignPath.io](https://signpath.io) tarafından sağlanmakta, sertifika [SignPath Foundation](https://signpath.org) tarafından verilmektedir.

## Lisans

Orca, [MIT Lisansı](../../LICENSE) altında ücretsiz ve açık kaynaklıdır.
