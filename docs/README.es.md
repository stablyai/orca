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

## [Nuevo] Anotar diff de IA

**Comenta directamente sobre los diffs generados por IA.**

Anota cualquier línea de un diff generado por IA con tus comentarios y mándalo de vuelta al agente para que lo corrija. Mantén el ciclo de revisión bien ajustado — sin copiar números de línea, sin cambiar de contexto.

<p align="center">

  <img src="assets/annotate-ai-diff.gif" alt="Orca Anotar diff de IA — comenta en diffs generados por IA y envía feedback al agente" width="800" />

</p>

---

## [Nuevo] Cambio rápido entre cuentas de Codex

**¿Varias cuentas de Codex? Cambia con un clic.**

Si usas varias cuentas de Codex para aprovechar el mejor precio en tokens, Orca te permite cambiar entre ellas al instante — sin volver a hacer login, sin tocar archivos de configuración. Elige una cuenta y sigue construyendo.

<p align="center">

  <img src="assets/codex-account-switcher.gif" alt="Cambio de cuentas de Codex en Orca — alterna entre múltiples cuentas de Codex" width="800" />

</p>

---

## [Nuevo] Navegador por worktree y modo diseño

**Mira tu app. Haz clic en cualquier elemento. Suéltalo en el chat.**

Orca trae un navegador integrado dentro de tu worktree. Previsualiza tu app mientras la construyes, y cuando quieras cambia al modo diseño — haz clic en cualquier elemento de UI y cae directo en tu chat con la IA como contexto. Sin capturas, sin copiar selectores. Solo apunta a lo que quieres cambiar y dile al agente qué hacer.

<p align="center">

  <img src="assets/orca-design-mode.gif" alt="Modo diseño de Orca — haz clic en cualquier elemento de UI y suéltalo en el chat" width="800" />

</p>

---

## [Nuevo] Presentamos el Orca CLI

**Orquestación de agentes desde tu terminal.**

Deja que tu agente de IA controle tu IDE. Usa IA para agregar proyectos al IDE, crear worktrees y actualizar el comentario del worktree actual con checkpoints de progreso directamente desde la terminal. Viene incluido con el Orca IDE (instálalo en Ajustes).

```bash
npx skills add https://github.com/stablyai/orca --skill orca-cli
```

---

## Comunidad y soporte

- **Discord:** Únete a la comunidad en **[Discord](https://discord.gg/fzjDKHxv8Q)**.
- **Twitter / X:** Sigue a **[@orca_build](https://x.com/orca_build)** para novedades y anuncios.
- **Feedback e ideas:** Lanzamos rápido. ¿Te falta algo? [Pide una nueva feature](https://github.com/stablyai/orca/issues).
- **Muéstranos tu apoyo:** Dale una estrella al repo para seguir nuestros lanzamientos diarios.

---

## Desarrollo

¿Quieres contribuir o ejecutar Orca localmente? Consulta nuestra guía [CONTRIBUTING.md](../CONTRIBUTING.md).
