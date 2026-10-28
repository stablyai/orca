<h1 align="center">
  <a href="https://onOrca.dev"><img src="../../resources/build/icon.png" alt="Orca" width="64" valign="middle" /></a> Orca
</h1>

<p align="center">
  <a href="https://github.com/stablyai/orca"><img src="https://img.shields.io/github/stars/stablyai/orca?style=flat&amp;label=%E2%98%85&amp;color=08C" alt="Звёзды на GitHub" /></a>
  <a href="https://github.com/stablyai/orca/releases"><img src="../assets/readme-downloads.svg" alt="Общее число скачиваний всех выпусков" /></a>
  <img src="https://img.shields.io/badge/license-MIT-08C?style=flat" alt="Лицензия: MIT" />
  <a href="https://discord.gg/fzjDKHxv8Q"><img src="https://img.shields.io/badge/Discord-5865F2?logo=discord&logoColor=white" alt="Присоединяйтесь к сообществу Orca в Discord" /></a>
  <a href="https://x.com/orca_build"><img src="https://img.shields.io/badge/X-000000?logo=x&logoColor=white" alt="Подпишитесь на Orca в X" /></a>
  <img src="https://img.shields.io/badge/macOS%20%7C%20Windows%20%7C%20Linux-4493F8?style=flat-square" alt="Поддерживаемые платформы: macOS, Windows и Linux" />
</p>

<p align="center">
  <sub><a href="../../README.md">English</a> · <a href="README.zh-CN.md">中文</a> · <a href="README.ja.md">日本語</a> · <a href="README.ko.md">한국어</a> · <a href="README.es.md">Español</a> · <a href="README.fr.md">Français</a> · <a href="README.pt.md">Português</a> · <a href="README.tr.md">Türkçe</a></sub>
</p>

<p align="center">
  <strong>Оркестратор ИИ для тех, кто создаёт в 100 раз больше.</strong><br/>
  Запускайте Codex, ClaudeCode, OpenCode или Pi параллельно — каждый в своём рабочем дереве, все под контролем в одном месте.
</p>

<h3 align="center"><a href="https://onorca.dev/download"><ins>Скачать Orca</ins></a></h3>

<p align="center">
  <img src="../assets/readme-hero.jpg" alt="Настольное приложение Orca с агентами в параллельных рабочих деревьях и мобильным приложением Orca в углу" width="960" />
</p>

## Возможности

<table>
<tr>
<td width="50%" valign="middle">

### Мобильное приложение

Следите за агентами и направляйте их работу с телефона — получайте уведомления о завершении задач и отправляйте дополнительные указания откуда угодно.

[App Store для iOS](https://apps.apple.com/us/app/orca-ide/id6766130217) · [APK для Android](https://www.onorca.dev/download/android) · [Документация →](https://www.onorca.dev/docs/mobile)

</td>
<td width="50%">
  <a href="https://www.onorca.dev/docs/mobile"><picture><source srcset="../assets/feature-wall/mobile-companion-app-showcase.gif" type="image/gif"><img src="../assets/feature-wall/mobile-companion-app-showcase.jpg" alt="Настольное и мобильное приложения Orca" width="100%" /></picture></a>
</td>
</tr>
<tr>
<td width="50%" valign="middle">

### Параллельные рабочие деревья

Отправьте один запрос пяти агентам, каждый из которых работает в своём изолированном рабочем дереве Git, — сравните результаты и слейте лучший вариант.

[Документация →](https://www.onorca.dev/docs/model/worktrees)

</td>
<td width="50%">
  <a href="https://www.onorca.dev/docs/model/worktrees"><picture><source srcset="../site/public/docs/tab-split.gif" type="image/gif"><img src="../site/public/docs/posters/tab-split.jpg" alt="Управление параллельными рабочими деревьями" width="100%" /></picture></a>
</td>
</tr>
<tr>
<td width="50%" valign="middle">

### Разделение терминала

Терминалы уровня Ghostty с отрисовкой через WebGL, неограниченным разделением на панели и историей вывода, которая сохраняется после перезапуска.

[Документация →](https://www.onorca.dev/docs/terminal)

</td>
<td width="50%">
  <a href="https://www.onorca.dev/docs/terminal"><picture><source srcset="../../resources/onboarding/feature-wall/tile-02.webp" type="image/webp"><img src="../../resources/onboarding/feature-wall/tile-02.poster.jpg" alt="Разделение терминала на панели" width="100%" /></picture></a>
</td>
</tr>
<tr>
<td width="50%" valign="middle">

### Режим дизайна

Нажмите на любой элемент интерфейса в настоящем окне Chromium, чтобы отправить его HTML, CSS и снимок соответствующей области экрана прямо в запрос агенту.

[Документация →](https://www.onorca.dev/docs/browser/design-mode)

</td>
<td width="50%">
  <a href="https://www.onorca.dev/docs/browser/design-mode"><picture><source srcset="../site/public/docs/orca-design-mode.gif" type="image/gif"><img src="../../resources/onboarding/feature-wall/tile-05.poster.jpg" alt="Встроенный браузер и режим дизайна" width="100%" /></picture></a>
</td>
</tr>
<tr>
<td width="50%" valign="middle">

### Встроенная поддержка GitHub и Linear

Просматривайте пул-реквесты, задачи и доски проектов прямо в приложении — открывайте рабочее дерево из любой задачи и проверяйте код, не переключая контекст.

[Документация →](https://www.onorca.dev/docs/review/linear)

</td>
<td width="50%">
  <a href="https://www.onorca.dev/docs/review/linear"><picture><source srcset="../../resources/onboarding/feature-wall/tile-03.webp" type="image/webp"><img src="../../resources/onboarding/feature-wall/tile-03.poster.jpg" alt="Работа с задачами GitHub и Linear в Orca" width="100%" /></picture></a>
</td>
</tr>
<tr>
<td width="50%" valign="middle">

### Рабочие деревья по SSH

Запускайте агентов на мощном удалённом сервере с полноценным редактированием файлов, работой с Git и терминалами — автоматическое переподключение и перенаправление портов уже предусмотрены.

[Документация →](https://www.onorca.dev/docs/ssh)

</td>
<td width="50%">
  <a href="https://www.onorca.dev/docs/ssh"><picture><source srcset="../../resources/onboarding/feature-wall/tile-06.webp" type="image/webp"><img src="../../resources/onboarding/feature-wall/tile-06.poster.jpg" alt="Удалённые рабочие деревья по SSH" width="100%" /></picture></a>
</td>
</tr>
<tr>
<td width="50%" valign="middle">

### Комментарии к изменениям ИИ

Оставляйте комментарии к любой строке в сравнении и отправляйте их агенту — проверяйте и редактируйте код, создавайте коммиты, не выходя из Orca.

[Документация →](https://www.onorca.dev/docs/review/annotate-ai-diff)

</td>
<td width="50%">
  <a href="https://www.onorca.dev/docs/review/annotate-ai-diff"><picture><source srcset="../site/public/docs/annotate-ai-diff.gif" type="image/gif"><img src="../../resources/onboarding/feature-wall/tile-08.poster.jpg" alt="Комментирование изменений, созданных ИИ" width="100%" /></picture></a>
</td>
</tr>
<tr>
<td width="50%" valign="middle">

### Перетаскивание файлов в запросы агентов

Редактор VS Code с автоматическим сохранением всех изменений — перетаскивайте файлы или изображения прямо в запрос агенту.

[Документация →](https://www.onorca.dev/docs/editing/file-explorer)

</td>
<td width="50%">
  <a href="https://www.onorca.dev/docs/editing/file-explorer"><picture><source srcset="../../resources/onboarding/feature-wall/tile-07.gif" type="image/gif"><img src="../../resources/onboarding/feature-wall/tile-07.poster.jpg" alt="Перетаскивание файлов и изображений в запрос агенту" width="100%" /></picture></a>
</td>
</tr>
<tr>
<td width="50%" valign="middle">

### Orca CLI

Агенты тоже управляют Orca — автоматизируйте любые рабочие процессы с помощью `orca worktree create`, `snapshot`, `click` и `fill`.

[Документация →](https://www.onorca.dev/docs/cli/overview)

</td>
<td width="50%">
  <a href="https://www.onorca.dev/docs/cli/overview"><picture><source srcset="../../resources/onboarding/feature-wall/tile-09.webp" type="image/webp"><img src="../../resources/onboarding/feature-wall/tile-09.poster.jpg" alt="Автоматизация Orca через CLI" width="100%" /></picture></a>
</td>
</tr>
</table>

**А ещё:**

- **[Быстрое открытие](https://www.onorca.dev/docs/model/quick-open)** — Ищите рабочие деревья, файлы, агентов, команды и контекст репозитория, не прерывая работу.
- **[Переключение учётных записей и учёт использования](https://www.onorca.dev/docs/agents/usage-tracking)** — Следите за использованием Claude и Codex и временем сброса лимитов, переключайтесь между учётными записями без повторного входа.
- **[Предпросмотр содержимого репозитория](https://www.onorca.dev/docs/editing/markdown)** — Просматривайте Markdown, изображения, PDF и документацию репозитория прямо в рабочем пространстве.
- **[Управление компьютером](https://www.onorca.dev/docs/cli/computer-use)** — Позвольте агентам управлять настольными приложениями и видимым интерфейсом, когда задача требует непосредственного взаимодействия.
- **[Уведомления и статус прочтения](https://www.onorca.dev/docs/notifications)** — Узнавайте, когда агент завершил работу или требует внимания, и отмечайте обсуждения как непрочитанные, чтобы вернуться к ним позже.
- **И многое, многое другое** — мы выпускаем обновления каждый день, поэтому этот список постоянно отстаёт. Актуальный список возможностей — в [журнале изменений](https://github.com/stablyai/orca/releases).

---

## Поддерживаемые агенты

Работает с **любым CLI-агентом** — если он запускается в терминале, то запустится и в Orca.

<p>
  <a href="https://docs.anthropic.com/claude/docs/claude-code"><kbd><img src="../assets/claude-logo.svg" alt="Логотип Claude Code" width="16" valign="middle" /> Claude Code</kbd></a> &nbsp;
  <a href="https://github.com/openai/codex"><kbd><img src="https://www.google.com/s2/favicons?domain=openai.com&sz=64" alt="Логотип Codex" width="16" valign="middle" /> Codex</kbd></a> &nbsp;
  <a href="https://x.ai/cli"><kbd><img src="https://www.google.com/s2/favicons?domain=x.ai&sz=64" alt="Логотип Grok" width="16" valign="middle" /> Grok</kbd></a> &nbsp;
  <a href="https://cursor.com/cli"><kbd><img src="https://www.google.com/s2/favicons?domain=cursor.com&sz=64" alt="Логотип Cursor" width="16" valign="middle" /> Cursor</kbd></a> &nbsp;
  <a href="https://docs.github.com/en/copilot/how-tos/set-up/install-copilot-cli"><kbd><img src="https://www.google.com/s2/favicons?domain=github.com&sz=64" alt="Логотип GitHub Copilot" width="16" valign="middle" /> GitHub Copilot</kbd></a> &nbsp;
  <a href="https://dev.meta.ai/docs/muse-code"><kbd><img src="../../src/shared/agent-icons/muse.png" alt="Логотип Muse" width="16" valign="middle" /> Muse</kbd></a> &nbsp;
  <a href="https://deepseek-harness.github.io/deepseek-harness/"><kbd><img src="../../src/shared/agent-icons/dsh.png" alt="Логотип DeepSeek Harness" width="16" valign="middle" /> DeepSeek Harness</kbd></a> &nbsp;
  <a href="https://zcode.z.ai/en/docs"><kbd><img src="../../src/shared/agent-icons/zcode.png" alt="Логотип ZCode" width="16" valign="middle" /> ZCode</kbd></a> &nbsp;
  <a href="https://opencode.ai/docs/cli/"><kbd><img src="https://www.google.com/s2/favicons?domain=opencode.ai&sz=64" alt="Логотип OpenCode" width="16" valign="middle" /> OpenCode</kbd></a> &nbsp;
  <a href="https://mimo.xiaomi.com/coder"><kbd><img src="https://www.google.com/s2/favicons?domain=mimo.xiaomi.com&sz=64" alt="Логотип MiMo Code" width="16" valign="middle" /> MiMo Code</kbd></a> &nbsp;
  <a href="https://ampcode.com/manual#install"><kbd><img src="https://www.google.com/s2/favicons?domain=ampcode.com&sz=64" alt="Логотип Amp" width="16" valign="middle" /> Amp</kbd></a> &nbsp;
  <a href="https://openclaude.gitlawb.com/"><kbd><img src="../../resources/openclaude-logo.png" alt="Логотип OpenClaude" width="16" valign="middle" /> OpenClaude</kbd></a> &nbsp;
  <a href="https://antigravity.google/docs/cli-overview"><kbd><img src="https://www.google.com/s2/favicons?domain=antigravity.google&sz=64" alt="Логотип Antigravity" width="16" valign="middle" /> Antigravity</kbd></a> &nbsp;
  <a href="https://pi.dev"><kbd><img src="https://pi.dev/favicon.svg" alt="Логотип Pi" width="16" valign="middle" /> Pi</kbd></a> &nbsp;
  <a href="https://omp.sh"><kbd><img src="https://omp.sh/favicon.svg" alt="Логотип oh-my-pi" width="16" valign="middle" /> oh-my-pi</kbd></a> &nbsp;
  <a href="https://hermes-agent.nousresearch.com/docs/"><kbd><img src="https://www.google.com/s2/favicons?domain=nousresearch.com&sz=64" alt="Логотип Hermes Agent" width="16" valign="middle" /> Hermes Agent</kbd></a> &nbsp;
  <a href="https://devin.ai/cli"><kbd><img src="https://www.google.com/s2/favicons?domain=devin.ai&sz=64" alt="Логотип Devin" width="16" valign="middle" /> Devin</kbd></a> &nbsp;
  <a href="https://goose-docs.ai/docs/quickstart/"><kbd><img src="https://www.google.com/s2/favicons?domain=goose-docs.ai&sz=64" alt="Логотип Goose" width="16" valign="middle" /> Goose</kbd></a> &nbsp;
  <a href="https://docs.augmentcode.com/cli/overview"><kbd><img src="https://www.google.com/s2/favicons?domain=augmentcode.com&sz=64" alt="Логотип Auggie" width="16" valign="middle" /> Auggie</kbd></a> &nbsp;
  <a href="https://github.com/autohandai/code-cli"><kbd><img src="https://www.google.com/s2/favicons?domain=autohand.ai&sz=64" alt="Логотип Autohand Code" width="16" valign="middle" /> Autohand Code</kbd></a> &nbsp;
  <a href="https://github.com/charmbracelet/crush"><kbd><img src="https://www.google.com/s2/favicons?domain=charm.sh&sz=64" alt="Логотип Charm" width="16" valign="middle" /> Charm</kbd></a> &nbsp;
  <a href="https://docs.cline.bot/cline-cli/overview"><kbd><img src="https://www.google.com/s2/favicons?domain=cline.bot&sz=64" alt="Логотип Cline" width="16" valign="middle" /> Cline</kbd></a> &nbsp;
  <a href="https://www.codebuddy.ai/cli"><kbd><img src="https://www.google.com/s2/favicons?domain=codebuddy.ai&sz=64" alt="Логотип CodeBuddy" width="16" valign="middle" /> CodeBuddy</kbd></a> &nbsp;
  <a href="https://www.codebuff.com/docs/help/quick-start"><kbd><img src="https://www.google.com/s2/favicons?domain=codebuff.com&sz=64" alt="Логотип Codebuff" width="16" valign="middle" /> Codebuff</kbd></a> &nbsp;
  <a href="https://freebuff.com"><kbd><img src="../../src/shared/agent-icons/freebuff.png" alt="Логотип Freebuff" width="16" valign="middle" /> Freebuff</kbd></a> &nbsp;
  <a href="https://commandcode.ai/docs/quickstart"><kbd><img src="https://www.google.com/s2/favicons?domain=commandcode.ai&sz=64" alt="Логотип Command Code" width="16" valign="middle" /> Command Code</kbd></a> &nbsp;
  <a href="https://docs.continue.dev/cli/quickstart"><kbd><img src="https://www.google.com/s2/favicons?domain=continue.dev&sz=64" alt="Логотип Continue" width="16" valign="middle" /> Continue</kbd></a> &nbsp;
  <a href="https://docs.factory.ai/cli/getting-started/quickstart"><kbd><img src="../assets/droid-logo.svg" alt="Логотип Droid" width="16" valign="middle" /> Droid</kbd></a> &nbsp;
  <a href="https://kilo.ai/docs/cli"><kbd><img src="https://raw.githubusercontent.com/Kilo-Org/kilocode/main/packages/kilo-vscode/assets/icons/kilo-light.svg" alt="Логотип Kilocode" width="16" valign="middle" /> Kilocode</kbd></a> &nbsp;
  <a href="https://www.kimi.com/code/docs/en/kimi-code-cli/getting-started.html"><kbd><img src="https://www.google.com/s2/favicons?domain=moonshot.cn&sz=64" alt="Логотип Kimi" width="16" valign="middle" /> Kimi</kbd></a> &nbsp;
  <a href="https://kiro.dev/docs/cli/"><kbd><img src="https://www.google.com/s2/favicons?domain=kiro.dev&sz=64" alt="Логотип Kiro" width="16" valign="middle" /> Kiro</kbd></a> &nbsp;
  <a href="https://github.com/mistralai/mistral-vibe"><kbd><img src="https://www.google.com/s2/favicons?domain=mistral.ai&sz=64" alt="Логотип Mistral Vibe" width="16" valign="middle" /> Mistral Vibe</kbd></a> &nbsp;
  <a href="https://github.com/QwenLM/qwen-code"><kbd><img src="https://www.google.com/s2/favicons?domain=qwenlm.github.io&sz=64" alt="Логотип Qwen Code" width="16" valign="middle" /> Qwen Code</kbd></a> &nbsp;
  <a href="https://support.atlassian.com/rovo/docs/install-and-run-rovo-dev-cli-on-your-device/"><kbd><img src="https://www.google.com/s2/favicons?domain=atlassian.com&sz=64" alt="Логотип Rovo Dev" width="16" valign="middle" /> Rovo Dev</kbd></a> &nbsp;
  <kbd>+ любой CLI-агент</kbd>
</p>

---

## Установка

### Настольное приложение — macOS, Windows, Linux

- **[Скачать с onOrca.dev](https://onorca.dev/download)**
- Или скачайте сборку напрямую: [macOS Apple Silicon](https://github.com/stablyai/orca/releases/latest/download/orca-macos-arm64.dmg) · [macOS Intel](https://github.com/stablyai/orca/releases/latest/download/orca-macos-x64.dmg) · [Windows (.exe)](https://github.com/stablyai/orca/releases/latest/download/orca-windows-setup.exe) · [Linux AppImage](https://github.com/stablyai/orca/releases/latest/download/orca-linux.AppImage) · [Все сборки](https://github.com/stablyai/orca/releases/latest)

_Или через менеджер пакетов:_

```bash
# macOS (Homebrew)
# Always use the full name; bare `orca` is an unrelated Plotly cask.
brew install --cask stablyai/orca/orca
# Upgrade an existing install
brew upgrade --cask stablyai/orca/orca

# Arch Linux (AUR) — or stably-orca-git to build from source
yay -S stably-orca-bin
```

### Мобильное приложение — iOS, Android

Подключите его к настольному приложению, чтобы следить за агентами и направлять их работу с телефона.

- **iOS:** [Скачать в App Store](https://apps.apple.com/us/app/orca-ide/id6766130217)
- **Android:** [Скачать APK](https://www.onorca.dev/download/android) · [Руководство по установке](https://www.onorca.dev/docs/android-apk)

---

## Сообщество и поддержка

- **Discord:** Присоединяйтесь к сообществу в **[Discord](https://discord.gg/fzjDKHxv8Q)**.
- **Twitter / X:** Подпишитесь на **[@orca_build](https://x.com/orca_build)**, чтобы узнавать об обновлениях и анонсах.
- **WeChat:** Группа № 12 заполнена. Отсканируйте QR-код, чтобы присоединиться к группе № 13 сообщества Orca в WeChat.

  <img src="../assets/wechat-qr-group13.jpg" alt="QR-код группы № 13 сообщества Orca в WeChat" width="160" />

- **Отзывы и идеи:** Мы быстро выпускаем обновления. Чего-то не хватает? [Предложите новую возможность](https://github.com/stablyai/orca/issues).
- **Конфиденциальность:** В [документации о конфиденциальности и телеметрии](https://www.onorca.dev/docs/telemetry) описано, какие анонимные данные об использовании собирает Orca и как отказаться от их сбора.
- **Поддержите проект:** Отметьте этот репозиторий [звездой](https://github.com/stablyai/orca), чтобы следить за нашими ежедневными выпусками.

---

## Разработка

Хотите внести вклад в проект или запустить его локально? Загляните в наше руководство [CONTRIBUTING.md](../../.github/CONTRIBUTING.md).

Сервис-посредник для подключения мобильного приложения к компьютеру тоже находится в этом репозитории —
в [`cloud/`](../../cloud/README.md), с отдельным рабочим пространством pnpm и руководством по настройке.

<a href="https://github.com/stablyai/orca/graphs/contributors">
  <img src="https://contrib.rocks/image?repo=stablyai/orca" alt="Участники проекта Orca" />
</a>

<p align="center">
  <img src="../assets/star-history.png" alt="График числа звёзд stablyai/orca на GitHub" width="880" />
</p>

## Подписанные сборки

Подписание кода для Windows спонсирует и обеспечивает [SignPath.io](https://signpath.io), сертификат предоставляет [SignPath Foundation](https://signpath.org).

## Лицензия

Orca — бесплатное ПО с открытым исходным кодом под [лицензией MIT](../../LICENSE).
