<h1 align="center">
  <a href="https://onOrca.dev"><img src="../../resources/build/icon.png" alt="Orca" width="64" valign="middle" /></a> Orca
</h1>

<p align="center">
  <a href="https://github.com/stablyai/orca"><img src="https://img.shields.io/github/stars/stablyai/orca?style=flat&amp;label=%E2%98%85&amp;color=08C" alt="Зірки на GitHub" /></a>
  <a href="https://github.com/stablyai/orca/releases"><img src="../assets/readme-downloads.svg" alt="Загальна кількість завантажень усіх релізів" /></a>
  <img src="https://img.shields.io/badge/license-MIT-08C?style=flat" alt="Ліцензія: MIT" />
  <a href="https://discord.gg/fzjDKHxv8Q"><img src="https://img.shields.io/badge/Discord-5865F2?logo=discord&logoColor=white" alt="Приєднатися до Discord Orca" /></a>
  <a href="https://x.com/orca_build"><img src="https://img.shields.io/badge/X-000000?logo=x&logoColor=white" alt="Стежити за Orca в X" /></a>
  <img src="https://img.shields.io/badge/macOS%20%7C%20Windows%20%7C%20Linux-4493F8?style=flat-square" alt="Підтримувані платформи: macOS, Windows і Linux" />
</p>

<p align="center">
  <sub><a href="../../README.md">English</a> · <a href="README.zh-CN.md">中文</a> · <a href="README.ja.md">日本語</a> · <a href="README.ko.md">한국어</a> · <a href="README.es.md">Español</a> · <a href="README.fr.md">Français</a> · <a href="README.pt.md">Português</a></sub>
</p>

<p align="center">
  <strong>AI-оркестратор для розробників рівня 100x.</strong><br/>
  Запускайте Codex, Claude Code, OpenCode або Pi паралельно — кожен у власному worktree, усі під контролем в одному місці.
</p>

<h3 align="center"><a href="https://onorca.dev/download"><ins>Завантажити Orca</ins></a></h3>

<p align="center">
  <img src="../assets/readme-hero.jpg" alt="Десктопний застосунок Orca запускає агентів у паралельних worktree, у кутку — супутній мобільний застосунок Orca" width="960" />
</p>

## Можливості

<table>
<tr>
<td width="50%" valign="middle">

### Супутній мобільний застосунок

Стежте за агентами та керуйте ними з телефону — отримуйте сповіщення про завершення роботи агента та надсилайте подальші вказівки, де б ви не були.

[App Store для iOS](https://apps.apple.com/us/app/orca-ide/id6766130217) · [TestFlight](https://testflight.apple.com/join/YjeGMQBA) · [Android APK 0.0.44](https://github.com/stablyai/orca/releases/download/mobile-android-v0.0.44/app-release.apk) · [Документація →](https://www.onorca.dev/docs/mobile)

</td>
<td width="50%">
  <a href="https://www.onorca.dev/docs/mobile"><picture><source srcset="../assets/feature-wall/mobile-companion-app-showcase.gif" type="image/gif"><img src="../assets/feature-wall/mobile-companion-app-showcase.jpg" alt="Десктоп Orca із супутнім мобільним застосунком" width="100%" /></picture></a>
</td>
</tr>
<tr>
<td width="50%" valign="middle">

### Паралельні worktree

Надішліть один промпт одразу п’ятьом агентам, кожен із яких працюватиме у власному ізольованому git worktree, — порівняйте результати та виконайте злиття найкращого з них.

[Документація →](https://www.onorca.dev/docs/model/worktrees)

</td>
<td width="50%">
  <a href="https://www.onorca.dev/docs/model/worktrees"><picture><source srcset="../assets/feature-wall/parallel-worktrees.gif" type="image/gif"><img src="../assets/feature-wall/parallel-worktrees.jpg" alt="Оркестрація паралельних worktree" width="100%" /></picture></a>
</td>
</tr>
<tr>
<td width="50%" valign="middle">

### Розділені термінали

Термінали рівня Ghostty з рендерингом на WebGL, необмеженою кількістю розділень і буфером прокручування, який зберігається після перезапуску.

[Документація →](https://www.onorca.dev/docs/terminal)

</td>
<td width="50%">
  <a href="https://www.onorca.dev/docs/terminal"><picture><source srcset="../assets/feature-wall/terminal-splits.gif" type="image/gif"><img src="../assets/feature-wall/terminal-splits.jpg" alt="Розділені термінали" width="100%" /></picture></a>
</td>
</tr>
<tr>
<td width="50%" valign="middle">

### Режим дизайну

Клацніть на будь-якому елементі інтерфейсу у справжньому вікні Chromium, щоб надіслати його HTML, CSS і обрізаний скриншот прямо в промпт агента.

[Документація →](https://www.onorca.dev/docs/browser/design-mode)

</td>
<td width="50%">
  <a href="https://www.onorca.dev/docs/browser/design-mode"><picture><source srcset="../assets/feature-wall/design-mode.gif" type="image/gif"><img src="../assets/feature-wall/design-mode.jpg" alt="Вбудований браузер і режим дизайну" width="100%" /></picture></a>
</td>
</tr>
<tr>
<td width="50%" valign="middle">

### GitHub і Linear, нативно

Переглядайте PR, issue та дошки проєктів прямо в застосунку — відкривайте worktree з будь-якої задачі та рев'юйте без перемикання контексту.

[Документація →](https://www.onorca.dev/docs/review/linear)

</td>
<td width="50%">
  <a href="https://www.onorca.dev/docs/review/linear"><picture><source srcset="../assets/feature-wall/github-linear.gif" type="image/gif"><img src="../assets/feature-wall/github-linear.jpg" alt="Робочі процеси GitHub і Linear в Orca" width="100%" /></picture></a>
</td>
</tr>
<tr>
<td width="50%" valign="middle">

### SSH worktree

Запускайте агентів на потужній віддаленій машині з повноцінним редагуванням файлів, git і терміналами — з автоперепідключенням і прокиданням портів.

[Документація →](https://www.onorca.dev/docs/ssh)

</td>
<td width="50%">
  <a href="https://www.onorca.dev/docs/ssh"><picture><source srcset="../assets/feature-wall/ssh-worktrees.gif" type="image/gif"><img src="../assets/feature-wall/ssh-worktrees.jpg" alt="Віддалені worktree через SSH" width="100%" /></picture></a>
</td>
</tr>
<tr>
<td width="50%" valign="middle">

### Анотуйте diff-и агентів

Залишайте коментарі на будь-якому рядку diff-у й надсилайте їх агенту — рев'юйте, редагуйте та комітьте, не виходячи з Orca.

[Документація →](https://www.onorca.dev/docs/review/annotate-ai-diff)

</td>
<td width="50%">
  <a href="https://www.onorca.dev/docs/review/annotate-ai-diff"><picture><source srcset="../assets/feature-wall/annotate-diff.gif" type="image/gif"><img src="../assets/feature-wall/annotate-diff.jpg" alt="Анотування diff-ів, згенерованих AI" width="100%" /></picture></a>
</td>
</tr>
<tr>
<td width="50%" valign="middle">

### Перетягуйте файли агентам

Редактор на базі VS Code з автозбереженням усюди — перетягуйте файли чи зображення прямо в промпт агента.

[Документація →](https://www.onorca.dev/docs/editing/file-explorer)

</td>
<td width="50%">
  <a href="https://www.onorca.dev/docs/editing/file-explorer"><picture><source srcset="../assets/feature-wall/file-drag.gif" type="image/gif"><img src="../assets/feature-wall/file-drag.jpg" alt="Перетягування файлів і зображень у промпт агента" width="100%" /></picture></a>
</td>
</tr>
<tr>
<td width="50%" valign="middle">

### Orca CLI

Агенти теж керують Orca — автоматизуйте будь-який робочий процес командами `orca worktree create`, `snapshot`, `click` і `fill`.

[Документація →](https://www.onorca.dev/docs/cli/overview)

</td>
<td width="50%">
  <a href="https://www.onorca.dev/docs/cli/overview"><picture><source srcset="../assets/feature-wall/orca-cli.gif" type="image/gif"><img src="../assets/feature-wall/orca-cli.jpg" alt="Керування Orca з CLI" width="100%" /></picture></a>
</td>
</tr>
</table>

**Також у комплекті:**

- **[Швидкий пошук](https://www.onorca.dev/docs/model/quick-open)** — Шукайте серед worktree, файлів, агентів, команд і контексту репозиторію, не відриваючись від роботи.
- **[Перемикач акаунтів і відстеження використання](https://www.onorca.dev/docs/agents/usage-tracking)** — Стежте за використанням Claude і Codex та скиданням лімітів, перемикайте акаунти на льоту без повторного входу.
- **[Розширені перегляди репозиторію](https://www.onorca.dev/docs/editing/markdown)** — Переглядайте Markdown, зображення, PDF та документацію репозиторію прямо в робочому просторі.
- **[Computer Use](https://www.onorca.dev/docs/cli/computer-use)** — Дозвольте агентам керувати десктопними застосунками та видимим інтерфейсом, коли робочий процес потребує реальної взаємодії.
- **[Сповіщення та статус непрочитаного](https://www.onorca.dev/docs/notifications)** — Дізнавайтеся, коли агент завершив роботу або потребує уваги, і позначайте треди як непрочитані, щоб повернутися пізніше.
- **І багато іншого** — ми випускаємо оновлення щодня, тож цей список завжди відстає. Справжній перелік можливостей — це [changelog](https://github.com/stablyai/orca/releases).

---

## Підтримувані агенти

Працює з **будь-яким CLI-агентом** — якщо він запускається в терміналі, він запуститься і в Orca.

<p>
  <a href="https://docs.anthropic.com/claude/docs/claude-code"><kbd><img src="../assets/claude-logo.svg" alt="Claude Code logo" width="16" valign="middle" /> Claude Code</kbd></a> &nbsp;
  <a href="https://github.com/openai/codex"><kbd><img src="https://www.google.com/s2/favicons?domain=openai.com&sz=64" alt="Codex logo" width="16" valign="middle" /> Codex</kbd></a> &nbsp;
  <a href="https://x.ai/cli"><kbd><img src="https://www.google.com/s2/favicons?domain=x.ai&sz=64" alt="Grok logo" width="16" valign="middle" /> Grok</kbd></a> &nbsp;
  <a href="https://cursor.com/cli"><kbd><img src="https://www.google.com/s2/favicons?domain=cursor.com&sz=64" alt="Cursor logo" width="16" valign="middle" /> Cursor</kbd></a> &nbsp;
  <a href="https://docs.github.com/en/copilot/how-tos/set-up/install-copilot-cli"><kbd><img src="https://www.google.com/s2/favicons?domain=github.com&sz=64" alt="GitHub Copilot logo" width="16" valign="middle" /> GitHub Copilot</kbd></a> &nbsp;
  <a href="https://opencode.ai/docs/cli/"><kbd><img src="https://www.google.com/s2/favicons?domain=opencode.ai&sz=64" alt="OpenCode logo" width="16" valign="middle" /> OpenCode</kbd></a> &nbsp;
  <a href="https://mimo.xiaomi.com/coder"><kbd><img src="https://www.google.com/s2/favicons?domain=mimo.xiaomi.com&sz=64" alt="MiMo Code logo" width="16" valign="middle" /> MiMo Code</kbd></a> &nbsp;
  <a href="https://ampcode.com/manual#install"><kbd><img src="https://www.google.com/s2/favicons?domain=ampcode.com&sz=64" alt="Amp logo" width="16" valign="middle" /> Amp</kbd></a> &nbsp;
  <a href="https://openclaude.gitlawb.com/"><kbd><img src="../../resources/openclaude-logo.png" alt="OpenClaude logo" width="16" valign="middle" /> OpenClaude</kbd></a> &nbsp;
  <a href="https://antigravity.google/docs/cli-overview"><kbd><img src="https://www.google.com/s2/favicons?domain=antigravity.google&sz=64" alt="Antigravity logo" width="16" valign="middle" /> Antigravity</kbd></a> &nbsp;
  <a href="https://pi.dev"><kbd><img src="https://pi.dev/favicon.svg" alt="Pi logo" width="16" valign="middle" /> Pi</kbd></a> &nbsp;
  <a href="https://omp.sh"><kbd><img src="https://omp.sh/favicon.svg" alt="oh-my-pi logo" width="16" valign="middle" /> oh-my-pi</kbd></a> &nbsp;
  <a href="https://hermes-agent.nousresearch.com/docs/"><kbd><img src="https://www.google.com/s2/favicons?domain=nousresearch.com&sz=64" alt="Hermes Agent logo" width="16" valign="middle" /> Hermes Agent</kbd></a> &nbsp;
  <a href="https://devin.ai/cli"><kbd><img src="https://www.google.com/s2/favicons?domain=devin.ai&sz=64" alt="Devin logo" width="16" valign="middle" /> Devin</kbd></a> &nbsp;
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
  <kbd>+ будь-який CLI-агент</kbd>
</p>

---

## Встановлення

### Десктоп — macOS, Windows, Linux

- **[Завантажити з onOrca.dev](https://onorca.dev/download)**
- Або завантажте білд напряму: [macOS Apple Silicon](https://github.com/stablyai/orca/releases/latest/download/orca-macos-arm64.dmg) · [macOS Intel](https://github.com/stablyai/orca/releases/latest/download/orca-macos-x64.dmg) · [Windows (.exe)](https://github.com/stablyai/orca/releases/latest/download/orca-windows-setup.exe) · [Linux AppImage](https://github.com/stablyai/orca/releases/latest/download/orca-linux.AppImage) · [Усі білди](https://github.com/stablyai/orca/releases/latest)
- Запускаєте `orca serve` на headless Linux-сервері? Дивіться [посібник із headless Linux-сервера](../reference/headless-linux-server.md).

_Або через пакетний менеджер:_

```bash
# macOS (Homebrew)
brew install --cask stablyai/orca/orca

# Arch Linux (AUR) — або stably-orca-git для збірки з джерела
yay -S stably-orca-bin
```

### Супутній мобільний застосунок — iOS, Android

Під’єднайте мобільний застосунок до десктопного, щоб стежити за агентами та керувати ними з телефону.

- **iOS:** [Завантажити з App Store](https://apps.apple.com/us/app/orca-ide/id6766130217) або [приєднатися до TestFlight](https://testflight.apple.com/join/YjeGMQBA)
- **Android:** [Завантажити APK 0.0.44](https://github.com/stablyai/orca/releases/download/mobile-android-v0.0.44/app-release.apk) · [Інструкція зі встановлення](https://www.onorca.dev/docs/android-apk)

---

## Спільнота та підтримка

- **Discord:** Приєднуйтеся до спільноти в **[Discord](https://discord.gg/fzjDKHxv8Q)**.
- **Twitter / X:** Стежте за **[@orca_build](https://x.com/orca_build)**, щоб бути в курсі оновлень і анонсів.
- **WeChat:** Відскануйте QR-код, щоб приєднатися до групи № 7 спільноти Orca у WeChat. Якщо вона заповнена, приєднайтеся до групи № 8.

  <img src="../assets/wechat-qr-group7.jpg" alt="QR-код групи WeChat 7 спільноти Orca" width="160" />&nbsp;&nbsp;
  <img src="../assets/wechat-qr-group8.jpg" alt="QR-код групи WeChat 8 спільноти Orca" width="160" />

- **Зворотний зв'язок та ідеї:** Ми випускаємо оновлення швидко. Чогось бракує? [Запропонуйте нову функцію](https://github.com/stablyai/orca/issues).
- **Конфіденційність:** Перегляньте [документацію про конфіденційність і телеметрію](https://www.onorca.dev/docs/telemetry), щоб дізнатися, які анонімні дані про використання збирає Orca і як від цього відмовитися.
- **Підтримайте нас:** Поставте [зірку](https://github.com/stablyai/orca) цьому репозиторію, щоб стежити за нашими щоденними релізами.

---

## Розробка

Хочете зробити внесок або запустити проєкт локально? Перегляньте наш посібник [CONTRIBUTING.md](../../.github/CONTRIBUTING.md).

<a href="https://github.com/stablyai/orca/graphs/contributors">
  <img src="https://contrib.rocks/image?repo=stablyai/orca" alt="Контриб'ютори Orca" />
</a>

<p align="center">
  <img src="../assets/star-history.png" alt="Графік історії зірок на GitHub для stablyai/orca" width="880" />
</p>

## Підписані білди
Підписання коду для Windows надано за підтримки [SignPath.io](https://signpath.io), сертифікат надано [SignPath Foundation](https://signpath.org).

## Ліцензія

Orca — безкоштовний проєкт із відкритим кодом за ліцензією [MIT](../../LICENSE).
