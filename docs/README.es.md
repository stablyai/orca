<h1 align="center">
  <a href="https://onOrca.dev"><img src="../resources/build/icon.png" alt="Orca" width="64" valign="middle" /></a> Orca
</h1>

<p align="center">
  <img src="https://img.shields.io/badge/Platform-macOS%20%7C%20Windows%20%7C%20Linux-blue?style=for-the-badge" alt="Plataformas compatibles" />
  <a href="https://discord.gg/fzjDKHxv8Q"><img src="https://img.shields.io/badge/Discord-Join-5865F2?style=for-the-badge&logo=discord&logoColor=white" alt="Discord" /></a>
  <a href="https://x.com/orca_build"><img src="https://img.shields.io/badge/%E2%80%8E-Follow_@orca__build-000000?style=for-the-badge&logo=x&logoColor=white" alt="Seguir en X" /></a>
</p>

<p align="center">
  <a href="../README.md">English</a> · <a href="README.zh-CN.md">中文</a> · <a href="README.ja.md">日本語</a> · <a href="README.es.md">Español</a>
</p>

<p align="center">
  <strong>El orquestador de IA para desarrolladores 100x.</strong><br/>
  Ejecuta Claude Code, Codex u OpenCode en paralelo entre repositorios — cada uno en su propio worktree, todo administrado desde un solo lugar.<br/>
  Disponible para <strong>macOS, Windows y Linux</strong>.
</p>

<p align="center">
  <a href="#instalación"><strong>Descargar 🐋</strong></a>
</p>

<p align="center">
  <img src="assets/file-drag.gif" alt="Captura de Orca" width="800" />
</p>

## Agentes compatibles

Orca es compatible con cualquier agente CLI (*no solo los de esta lista*).

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

## Características

- **Sin login** — Usa tu propia suscripción de Claude Code o Codex.
- **Nativo con worktrees** — Cada feature vive en su propio worktree. Nada de stash ni malabares entre ramas. Crea y cambia al instante.
- **Terminales multi-agente** — Ejecuta varios agentes de IA en paralelo en pestañas y paneles. Mira de un vistazo cuáles están activos.
- **Control de versiones integrado** — Revisa los diffs generados por IA, haz ediciones rápidas y haz commit sin salir de Orca.
- **Integración con GitHub** — PRs, issues y checks de Actions vinculados automáticamente a cada worktree.
- **Soporte SSH** — Conéctate a máquinas remotas y ejecuta agentes en ellas directamente desde Orca.
- **Notificaciones** — Entérate cuando un agente termine o necesite tu atención. Marca hilos como no leídos para retomarlos después.

---

## Instalación

### Mac, Linux, Windows

- **[Descarga desde onOrca.dev](https://onOrca.dev)**
- O desde la **[página de GitHub Releases](https://github.com/stablyai/orca/releases/latest)**

*También puedes instalar desde un gestor de paquetes:*

### macOS (Homebrew)

```bash
brew install --cask stablyai/orca/orca
```

### Arch Linux (AUR)

```bash
# Binario precompilado
yay -S stably-orca-bin

# Compilar desde el código de GitHub
yay -S stably-orca-git
```

---

## App companion móvil

Controla tus agentes desde el teléfono.

<p align="center">
  <picture><source srcset="assets/feature-wall/mobile-companion-app-showcase.gif" type="image/gif"><img src="assets/feature-wall/mobile-companion-app-showcase.jpg" alt="Orca de escritorio con la app companion móvil" width="720" /></picture>
</p>

- **iOS:** [Descargar desde App Store](https://apps.apple.com/us/app/orca-ide/id6766130217)
- **Android:** [Descargar desde GH release (busca la versión mobile más reciente)](https://github.com/stablyai/orca/releases)

---

## Showcase de funciones

Haz clic en cualquier tarjeta para explorar el flujo de trabajo.

<p align="center">
  <a href="https://www.onorca.dev/docs/model/worktrees"><kbd><strong>Worktrees en paralelo</strong><br/><br/><picture><source srcset="assets/feature-wall/parallel-worktrees.gif" type="image/gif"><img src="assets/feature-wall/parallel-worktrees.jpg" alt="Orquestación de worktrees en paralelo" width="390" /></picture><br/></kbd></a> &nbsp;&nbsp;
  <a href="https://www.onorca.dev/docs/terminal"><kbd><strong>Terminales divididas</strong><br/><br/><picture><source srcset="assets/feature-wall/terminal-splits.gif" type="image/gif"><img src="assets/feature-wall/terminal-splits.jpg" alt="Terminales divididas de nivel Ghostty" width="390" /></picture><br/></kbd></a><br/><br/>
  <a href="https://www.onorca.dev/docs/browser/design-mode"><kbd><strong>Modo diseño</strong><br/><br/><picture><source srcset="assets/feature-wall/design-mode.gif" type="image/gif"><img src="assets/feature-wall/design-mode.jpg" alt="Navegador integrado y modo diseño" width="390" /></picture><br/></kbd></a> &nbsp;&nbsp;
  <a href="https://www.onorca.dev/docs/review/linear"><kbd><strong>GitHub y Linear nativos</strong><br/><br/><picture><source srcset="assets/feature-wall/github-linear.gif" type="image/gif"><img src="assets/feature-wall/github-linear.jpg" alt="Flujos de GitHub y Linear en Orca" width="390" /></picture><br/></kbd></a><br/><br/>
  <a href="https://www.onorca.dev/docs/agents/supported"><kbd><strong>Cualquier agente CLI</strong><br/><br/><picture><source srcset="assets/feature-wall/cli-agents.gif" type="image/gif"><img src="assets/feature-wall/cli-agents.jpg" alt="Compatible con cualquier agente CLI" width="390" /></picture><br/></kbd></a> &nbsp;&nbsp;
  <a href="https://www.onorca.dev/docs/ssh"><kbd><strong>Worktrees por SSH</strong><br/><br/><picture><source srcset="assets/feature-wall/ssh-worktrees.gif" type="image/gif"><img src="assets/feature-wall/ssh-worktrees.jpg" alt="Worktrees remotos por SSH" width="390" /></picture><br/></kbd></a><br/><br/>
  <a href="https://www.onorca.dev/docs/editing/file-explorer"><kbd><strong>Archivos a agentes</strong><br/><br/><picture><source srcset="assets/feature-wall/file-drag.gif" type="image/gif"><img src="assets/feature-wall/file-drag.jpg" alt="Arrastra archivos e imágenes al prompt de un agente" width="390" /></picture><br/></kbd></a> &nbsp;&nbsp;
  <a href="https://www.onorca.dev/docs/review/annotate-ai-diff"><kbd><strong>Anotar diffs de IA</strong><br/><br/><picture><source srcset="assets/feature-wall/annotate-diff.gif" type="image/gif"><img src="assets/feature-wall/annotate-diff.jpg" alt="Anotar diffs generados por IA" width="390" /></picture><br/></kbd></a><br/><br/>
  <a href="https://www.onorca.dev/docs/cli/overview"><kbd><strong>Orca CLI</strong><br/><br/><picture><source srcset="assets/feature-wall/orca-cli.gif" type="image/gif"><img src="assets/feature-wall/orca-cli.jpg" alt="Automatiza Orca desde la CLI" width="390" /></picture><br/></kbd></a> &nbsp;&nbsp;
  <a href="https://www.onorca.dev/docs/settings"><kbd><strong>Búsqueda nativa</strong><br/><br/><picture><source srcset="assets/feature-wall/keyboard-native.gif" type="image/gif"><img src="assets/feature-wall/keyboard-native.jpg" alt="Búsqueda nativa en los flujos de Orca" width="390" /></picture><br/></kbd></a><br/><br/>
  <a href="https://www.onorca.dev/docs/agents/usage-tracking"><kbd><strong>Cambio de cuenta y seguimiento de uso</strong><br/><br/><picture><source srcset="assets/feature-wall/codex-accounts.gif" type="image/gif"><img src="assets/feature-wall/codex-accounts.jpg" alt="Cambio de cuenta y seguimiento de uso" width="390" /></picture><br/></kbd></a> &nbsp;&nbsp;
  <a href="https://www.onorca.dev/docs/editing/markdown"><kbd><strong>Previews ricos del repo</strong><br/><br/><picture><source srcset="assets/feature-wall/markdown-editor.gif" type="image/gif"><img src="assets/feature-wall/markdown-editor.jpg" alt="Previsualización de Markdown, imágenes, PDFs y documentos del repo" width="390" /></picture><br/></kbd></a><br/><br/>
  <a href="https://www.onorca.dev/docs/model/tabs-panes-splits"><kbd><strong>Divide cualquier cosa</strong><br/><br/><picture><source srcset="assets/feature-wall/split-screen.gif" type="image/gif"><img src="assets/feature-wall/split-screen.jpg" alt="Paneles divididos para agentes, terminales, navegadores y archivos" width="390" /></picture><br/></kbd></a>
</p>

---

## Comunidad y soporte

- **Discord:** Únete a la comunidad en **[Discord](https://discord.gg/fzjDKHxv8Q)**.
- **Twitter / X:** Sigue a **[@orca_build](https://x.com/orca_build)** para novedades y anuncios.
- **Feedback e ideas:** Lanzamos rápido. ¿Te falta algo? [Pide una nueva feature](https://github.com/stablyai/orca/issues).
- **Muéstranos tu apoyo:** Dale una estrella al repo para seguir nuestros lanzamientos diarios.

---

## Desarrollo

¿Quieres contribuir o ejecutar Orca localmente? Consulta nuestra guía [CONTRIBUTING.md](../.github/CONTRIBUTING.md).
