# Zotz — Plan de trabajo

Zotz es un fork de [stablyai/orca](https://github.com/stablyai/orca) para correr en una MSI con Windows encendida 24/7 como **nodo remoto de agentes**. Hugo le manda tareas a distancia por **Tailscale** y los agentes (**Claude Code, Codex y Antigravity**) trabajan con acceso total a la máquina, sin que Orca ni ningún servicio externo se meta.

> Mascota y logo: un murciélago (_zotz_ en maya). Trabaja de noche, se orienta solo en la oscuridad y le gusta a los devs nocturnos.

---

## Reglas para quien ejecute este plan

1. **Lee `AGENTS.md` antes de tocar nada.** Sus reglas de gates, estilo y multiplataforma aplican aquí.
2. **Una fase por rama/PR**: `zotz/fase-N-<tema>`. No mezcles fases.
3. **Diff mínimo contra upstream.** Vamos a seguir jalando cambios de Orca, así que:
   - Cambia **configuración, defaults y textos visibles**, no renombres identificadores internos en masa.
   - **No renombres** variables `ORCA_*`, paquetes `@orca/*`, nombres de RPC ni el protocolo de pairing. Si lo haces, se rompe la compatibilidad con la app móvil oficial de Orca y cada sync con upstream va a ser un infierno.
   - Si necesitas lógica nueva, ponla en archivos nuevos con nombre `zotz-*` y engánchala con un cambio de pocas líneas en el código existente.
4. **No borres features de upstream**: desactívalas desde un default o un guard. Así hacer rebase es barato.
5. Antes de cada push: `pnpm check:changed`. Nunca `--no-verify`.
6. Apps lanzadas por agentes: `ORCA_BACKGROUND_LAUNCH=1`.
7. Al terminar cada fase, marca su checklist en este archivo y anota en **Bitácora** lo que cambió y cualquier sorpresa.

---

## Fase 0 — Setup del repo

- [x] Agregar el remote upstream: `git remote add upstream https://github.com/stablyai/orca.git`.
- [x] Documentar en `docs/zotz/SYNC.md` cómo sincronizar: `git fetch upstream && git rebase upstream/main` (o merge) en una rama `zotz/sync-YYYY-MM-DD`, resolver conflictos y correr los gates.
- [x] `LICENSE`: **dejar intacto** el copyright de StablyAI (MIT lo exige) y agregar debajo `Copyright (c) 2026 Hugo Rodríguez (Zotz modifications)`.
- [x] README: agregar arriba una sección corta "Zotz es un fork de Orca" con link al original. El resto del README se queda.
- [x] Revisar `.github/workflows`: desactivar los workflows de release/publish que apunten a stablyai o requieran sus secrets (renombrar a `.disabled` o agregar `if: github.repository == 'stablyai/orca'`). Los de CI (lint/test) se quedan.

**Listo cuando:** CI corre verde en el fork y ningún workflow intenta publicar.

---

## Fase 1 — Rebrand a Zotz

Archivos clave:

| Qué                      | Dónde                                                                                      | Cambio                                                                                                                                              |
| ------------------------ | ------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| Nombre del paquete y CLI | `package.json` → `name`, `bin`                                                             | `name: "zotz"`, `bin: { "zotz": "./out/cli/index.js" }`. Quitar el bin `orca` para no chocar con una instalación de Orca.                           |
| App ID                   | `config/electron-builder.config.cjs:126`                                                   | `const appId = 'dev.hugorodriguez.zotz'`                                                                                                            |
| Nombre visible           | mismo archivo, `productName` (≈ línea 254)                                                 | `'Zotz'`                                                                                                                                            |
| Protocolo de links       | mismo archivo, `protocols` (≈ línea 255)                                                   | `[{ name: 'Zotz', schemes: ['zotz'] }]`                                                                                                             |
| Ejecutables              | mismo archivo, `executableName` (≈ líneas 562 y 705)                                       | `'Zotz'` / `'zotz'`                                                                                                                                 |
| Publisher de Windows     | mismo archivo (≈ línea 568)                                                                | quitar `SignPath Foundation`; sin firma por ahora                                                                                                   |
| Feed de publish          | mismo archivo, `publish` (≈ línea 787)                                                     | `owner: 'HugoRodriguezDEV'`, `repo: 'zotz'`                                                                                                         |
| Directorio de datos      | `src/cli/runtime/profile/metadata.ts` (`getPlatformUserDataPath`) y su contraparte en main | Debe resolver a una carpeta `Zotz`, separada de la de Orca. Confirmar que la CLI y la app de Electron resuelven **la misma** ruta.                  |
| Íconos                   | `resources/build/` (icon.icns, .ico, .png), `resources/tray/`, `resources/app-icons/`      | Reemplazar por el murciélago (ver Fase 1b). Mismos nombres y tamaños de archivo.                                                                    |
| Textos visibles          | menús, título de ventana, tray, ayuda de la CLI, onboarding                                | "Orca" → "Zotz" **solo en strings visibles al usuario** y solo en el locale base (`en`) + `es` si existe. No toques los demás idiomas en esta fase. |

- [x] Aplicar la tabla.
- [x] `grep -rn "'Orca'\|\"Orca\"" src/main src/renderer src/cli` para encontrar strings visibles que se hayan escapado. Cambiar solo las visibles.
- [x] Verificar que `zotz --help` y `zotz serve --help` muestran "zotz".

**Fase 1b — Logo:** crear `resources/icon-source/zotz-bat.svg` (murciélago minimalista, legible a 16px, que funcione en monocromo para la bandeja del sistema) y regenerar los íconos con el script que ya usa `resources/icon-source/` (buscarlo antes de escribir uno nuevo).

**Listo cuando:** un build de Windows instala como "Zotz", con ícono de murciélago, convive con Orca instalado y guarda datos en su propia carpeta.

---

## Fase 2 — Cero telemetría y cero "phone home"

Hoy Orca manda eventos a PostHog y se conecta a varios dominios de `onorca.dev`.

### 2a. Telemetría

- [x] `src/main/telemetry/consent.ts` → `resolveEnvOverride()`: hacer que siempre regrese `{ effective: 'disabled', reason: 'orca_disabled' }` (reutiliza la razón existente para no tocar tipos). Un cambio de una línea al inicio de la función.
- [x] `src/main/telemetry/posthog-client-start.ts`: guard para que nunca arranque el cliente.
- [x] `src/main/telemetry/mobile-client-telemetry.ts` y `wsl-usage-reporter.ts`: confirmar que respetan el consent; si no, mismo guard.
- [x] Ocultar en Settings el toggle y el banner de telemetría (no tiene caso mostrarlo).
- [x] `src/main/crash-reporting/capture/crashpad-capture.ts`: confirmar que no sube nada (`uploadToServer: false`). Los dumps locales se quedan.
- [x] `src/main/star-nag`: desactivar (es el aviso de "danos una estrella en GitHub").

### 2b. Endpoints de `onorca.dev`

Encontrados en `src/`: `share.`, `push.`, `relay.`, `relay-c1.`, `c2.relay.`, `login.`, `connector.`, `www.onorca.dev`.

- [x] Centralizar en un archivo nuevo `src/shared/zotz/zotz-network-policy.ts` una lista de features cloud permitidas (por default **ninguna**) y usarla como guard en cada punto donde se usan esos dominios.
- [x] **relay**: desactivado. El pairing va directo por Tailscale (ver Fase 5); no se usa `--relay`.
- [x] **share / connector / login**: desactivados y ocultos en la UI.
- [ ] **push**: ver _Decisiones abiertas_. No lo desactives hasta que Hugo decida.

**Listo cuando:** al arrancar la app y usarla 10 minutos con un agente corriendo, el monitor de red (`read_network_requests` o Wireshark/Resource Monitor) **no muestra** tráfico a `posthog`, `onorca.dev` ni `stablyai` (salvo `push` si se decidió dejarlo).

---

## Fase 3 — Updates bajo control

Un auto-update del Orca original pisaría el fork o reiniciaría la app a media tarea.

- [x] `src/main/updater/updater-service.ts`: hacer que `checkForUpdates()` y la revisión automática no hagan nada, salvo que `ZOTZ_ENABLE_UPDATER=1`. Dejar `checkForUpdatesFromMenu` mostrando un mensaje de "Zotz se actualiza con git pull + build".
- [x] `src/main/updater/serve-update-handoff.ts`: confirmar que el modo `serve` no se auto-actualiza.
- [x] Plugins: default de `ORCA_PLUGIN_AUTO_UPDATE` en `src/main/startup/plugin-startup/main-process-plugins.ts` → apagado.
- [x] Ocultar los nudges de update (`src/main/updater/nudges`).
- [x] Escribir `docs/zotz/UPDATE.md`: cómo actualizar Zotz en la MSI (`git pull`, `pnpm install`, `pnpm build`, reiniciar el servicio).

**Listo cuando:** la app corre 24 h sin pedir ni instalar updates.

---

## Fase 4 — Agentes: Claude Code, Codex y Antigravity con acceso total

Orca ya trae casi todo:

- Default global de permisos: `src/shared/default-global-settings.ts:262` → `agentPermissionDefault: 'full-access'`. **Ya está en full-access**; confirmar que un perfil nuevo lo hereda y que `src/shared/agent-launch/choices/agent-launch-profile.ts:161` (`'own'`) no lo pisa en el perfil por defecto.
- Flags por agente: `src/shared/agent-launch/permissions/tui-agent-permissions.ts` (`YOLO_TUI_AGENT_ARGS`).
  - Claude Code (`claude`): `--dangerously-skip-permissions`
  - Codex (`codex`): la receta de full-access de ese archivo
  - Antigravity (`agy`): `--dangerously-skip-permissions` (línea 21)
- Comandos de detección: `src/shared/agent-launch/catalog/tui-agent-config.ts` (`claude`, `codex`, `agy`).

Tareas:

- [ ] Verificar en Windows que los tres CLIs se detectan (`where claude`, `where codex`, `where agy`) y arrancan en full-access desde terminal **y** desde chat.
- [ ] Codex: confirmar que full-access implica `--sandbox danger-full-access` y sin aprobaciones, también en `src/shared/agent-launch/permissions/codex-permission-policy.ts`.
- [ ] Workspace trust: confirmar que `agent-workspace-trust-decision.ts` / `workspace-pretrust-scope.ts` no frenan a ningún agente con un prompt de "¿confías en esta carpeta?". Si lo hacen, pre-confiar las carpetas de trabajo de la MSI.
- [ ] Setting nuevo `zotzVisibleAgents` (default `['claude', 'codex', 'antigravity']`) para que la UI y el selector solo muestren esos tres. **No borres** los demás agentes del catálogo; solo ocúltalos.

**Listo cuando:** desde el móvil o la laptop, por Tailscale, lanzas una tarea a cada uno de los tres agentes y la completan sin pedir ninguna aprobación.

---

## Fase 5 — Nodo 24/7 en Windows

Hoy `orca serve service` **no existe en Windows**: `src/cli/server/serve-service.ts:57` lanza _"not available on Windows yet"_. Linux y mac usan `src/cli/runtime/serve/supervision/serve-service-unit.ts`.

### 5a. `zotz serve service` para Windows

- [ ] Implementar la variante de Windows en `serve-service-unit.ts`, siguiendo el patrón de las otras plataformas: `install`, `status` y `uninstall`.
- [ ] Mecanismo: **Tarea programada de Windows** (`schtasks` o `Register-ScheduledTask` vía PowerShell), **no** un servicio de Windows. Un servicio corre en la sesión 0, sin escritorio, y entonces computer use y el navegador no funcionan.
  - Disparador: _al iniciar sesión_ del usuario dedicado.
  - Reiniciar si falla: cada 1 min, intentos ilimitados.
  - Sin límite de tiempo de ejecución.
  - "Ejecutar aunque esté con batería".
- [ ] Usar `runProcess` de `@orca/process-host` (ya importado), no `child_process` directo. Leer `docs/agents-md-refs/cross-platform-support.md` antes.

### 5b. Que Windows no se duerma

`src/main/power/` solo tiene asserts de mac (`macos-system-sleep-assertion.ts`) y Linux (`linux-lid-sleep-assertion.ts`).

- [ ] Agregar `windows-system-sleep-assertion.ts` con `powerSaveBlocker.start('prevent-app-suspension')` de Electron (o `SetThreadExecutionState` si hace falta más fuerza), y conectarlo en `agent-awake-service.ts`. En modo serve debe estar activo **siempre**, no solo mientras haya un agente corriendo.

### 5c. Script de preparación de la MSI

Crear `scripts/windows/zotz-node-setup.ps1` (idempotente, requiere admin, cada paso imprime qué hizo):

- [ ] `powercfg`: nunca suspender ni hibernar con corriente, y que cerrar la tapa no haga nada.
- [ ] Windows Update: horas activas 0–23 y sin reinicio automático con sesión iniciada (`NoAutoRebootWithLoggedOnUsers`).
- [ ] Inicio de sesión automático del usuario dedicado (vía Sysinternals Autologon; documentarlo, no guardar la contraseña en texto plano).
- [ ] Instalar y habilitar **OpenSSH Server**, solo con llave (`PasswordAuthentication no`).
- [ ] Regla de firewall: el puerto de `zotz serve` y el 22 **solo** desde la interfaz de Tailscale (`100.64.0.0/10`).
- [ ] Llamar a `zotz serve service install --bind <IP-tailscale>`.
- [ ] Nota para Hugo, no automatizable: en el BIOS de la MSI, activar _Restore on AC Power Loss_ (o equivalente).

**Listo cuando:** desconectas y reconectas la corriente, la MSI prende sola, inicia sesión, Zotz levanta en modo serve y en menos de 2 minutos puedes mandarle una tarea por Tailscale.

---

## Fase 6 — Acceso remoto por Tailscale

- [ ] `zotz serve` escucha **solo** en la IP de Tailscale de la MSI (`--bind`, ver `src/cli/runtime/commands/serve-bind-flag.ts`), nunca en `0.0.0.0`.
- [ ] Pairing directo por la tailnet, sin relay: `zotz serve pair` (ver `src/cli/server/pair.ts`).
- [ ] Probar el pairing desde: (1) la laptop de Hugo con Zotz u Orca, (2) la app móvil oficial de Orca. Si la app móvil oficial no puede parear sin relay, anotarlo en _Decisiones abiertas_.
- [ ] Documentar en `docs/zotz/REMOTE.md` cómo conectarse: Tailscale, pairing, SSH de respaldo.

---

## Fase 7 — Higiene de seguridad (acceso total ≠ acceso a todo)

Los agentes tienen acceso total **a la MSI**; que esa máquina no tenga nada que no deba perderse.

- [ ] Usuario de Windows dedicado (`zotz`), sin la sesión de Chrome personal de Hugo y sin datos de negocios ni de clientes.
- [ ] Tokens con alcance mínimo y revocables: GitHub fine-grained, solo con acceso a los repos que el nodo trabaja.
- [ ] Respaldo: punto de restauración de Windows antes de la primera puesta en marcha y backup semanal de la carpeta de datos de Zotz.
- [ ] Documentar todo en `docs/zotz/SECURITY.md`.

---

## Decisiones abiertas (las resuelve Hugo)

1. **Notificaciones push al celular** (`push.onorca.dev`): las manda la infraestructura de StablyAI. Opciones: (a) dejarlas, que es cómodo pero los avisos pasan por sus servidores; (b) apagarlas y usar un bot propio de Telegram para los avisos (sería una Fase 8).
2. **App móvil**: ¿usar la app oficial de Orca pareada por Tailscale, o compilar la propia (`mobile/`) más adelante?
3. **Firma del instalador de Windows**: por ahora sin firmar (SmartScreen avisará al instalar). Más adelante se puede usar un certificado propio.

---

## Orden y alcance sugeridos

| Fase                | Depende de | Tamaño                                 |
| ------------------- | ---------- | -------------------------------------- |
| 0 Setup             | —          | S                                      |
| 1 Rebrand + 1b logo | 0          | M                                      |
| 2 Telemetría y red  | 0          | M                                      |
| 3 Updates           | 0          | S                                      |
| 4 Agentes           | 1          | S                                      |
| 5 Nodo 24/7 Windows | 1, 3       | L                                      |
| 6 Tailscale         | 5          | S                                      |
| 7 Seguridad         | 5          | S (en su mayoría docs y configuración) |

Las fases 1, 2 y 3 se pueden trabajar en paralelo en worktrees separados.

---

## Bitácora

<!-- Cada fase agrega aquí: fecha, rama/PR, qué cambió, sorpresas. -->

### 2026-11-15 — Fase 0 (`zotz/fase-0-setup`, PR #1)

- Remote `upstream` → `stablyai/orca` (config local de cada clon; documentado en `docs/zotz/SYNC.md`).
- `docs/zotz/SYNC.md`: flujo `zotz/sync-YYYY-MM-DD`, zonas de conflicto y grep para detectar workflows de publish sin guard.
- `LICENSE` y `README.md`: línea de copyright de Zotz y nota de fork arriba.
- Workflows: guard `github.repository == 'stablyai/orca'` en `agent-state-rules-publish`, `homebrew-bump`, `mobile-android-release`, `mobile-ios-release`, `release-mirror-r2`, `windows-signing-rehearsal` y `pullfrog`. Los de release-cut/hourly/daily/adhoc/dev-channel/docs/readme-badge/release-policy ya traían el guard. Se usó guard (no `.disabled`) para que los `workflow_call` sigan resolviendo y el rebase sea barato.
- Gates: `pnpm check:changed` ✓ (31 checks).

**Sorpresas**

- El copyright de `LICENSE` es de **Lovecast Inc.**, no "StablyAI"; se dejó intacto.
- La Mac no tenía Node ni pnpm: se instaló `node@24` con Homebrew y pnpm 12.14.0 vía `corepack` (`export PATH="/opt/homebrew/opt/node@24/bin:$PATH"`, `corepack pnpm …`).
- El snapshot de upstream del fork venía roto (import a `shared/structural-value-equality`, que se movió a `shared/collections/`): tumbaba los unit tests. Se hizo cherry-pick del fix de upstream `2e77caf0ea` (#42793); el próximo sync lo reconoce como el mismo parche.
- `release-javascript.yml` usa `ORCA_POSTHOG_WRITE_KEY` pero no publica; sin el secret el bundle sale sin llave (se termina de cortar en Fase 2).

### 2026-11-15 — Fase 1 (`zotz/fase-1-rebrand`, PR #3)

**Qué cambió**

- Identidad centralizada en `src/shared/zotz/zotz-app-identity.ts` (`Zotz`, `dev.hugorodriguez.zotz`, carpeta `zotz`, comando `zotz`, esquema `zotz://`).
- `package.json`: `name: zotz`, bin `zotz` (se quitó `orca`; `orca-dev` se queda). `verify-cli-bin.mjs` ahora exige `bin.zotz`.
- `electron-builder.config.cjs`: appId, productName, protocolo `zotz://`, ejecutable `Zotz.exe` (en Linux se mantiene `orca-ide`: la caché/extracción del AppImage y los oráculos de CI dependen de ese nombre), sin publisher de SignPath (sin firma), feed `HugoRodriguezDEV/zotz`, `StartupWMClass: zotz`.
- Carpeta de datos: Electron la deriva de `package.json` `name` → `zotz` (minúscula, igual que upstream con `orca`). La CLI (`getPlatformUserDataPath`), `getOrcaUserDataPath` (hooks de Codex offline), `macCoordinationRoot`, el fallback de `logs-directory` y el script de hooks de Command Code usan la misma constante.
- Windows convive con Orca: `%LOCALAPPDATA%\Zotz\daemon-host` (TS + NSIS), ProgIDs `Zotz.Markdown`/`Zotz.Tabular`, registro de protocolo `zotz://` (ya no le roba `orca://` a Orca), AppUserModelId = appId.
- `LOCAL_BUILD_COMPATIBILITY_CONTRACT.appId` (json + ts) y los bundle ids de macOS (notificaciones, press-and-hold) apuntan al nuevo appId.
- Textos visibles: título de ventana, tray (tooltip, “Open Zotz”, aviso de minimizar), menú (About/Hide/Explore/Getting Started/tooltip de Quit), notificación push, titlebar, onboarding, status bar, crash dialog, slide móvil; claves en `en.json` y `es.json`.
- CLI: el nombre por defecto del comando es `zotz` (`resolveInvokedCliCommand`); la ayuda cambia “Orca” → “Zotz” vía `src/cli/discovery/zotz-help-branding.ts`. `zotz --help` y `zotz serve --help` verificados.
- Fase 1b: `resources/icon-source/zotz-bat.svg` + `icon.icon/Assets/logo.svg` y `resources/logo.svg` con el murciélago; regenerados `build/icon.{png,icns,ico}`, `resources/icon.png`, `tray/*Template*.png` y `app-icons/*.png` con los mismos nombres y tamaños.

**Sorpresas / pendientes**

- `resources/icon-source/generate.sh` necesita `xcrun actool` (Xcode completo) e ImageMagick; esta Mac solo tiene CommandLineTools. Los íconos se rasterizaron con `resvg` (brew) + `iconutil` + el script existente `trim-windows-icon-source.mjs` para el `.ico`. En una Mac con Xcode, `pnpm build:icons` regenera desde el nuevo `logo.svg` (el estilo Icon Composer quedará algo distinto).
- El launcher de la CLI empaquetado sigue llamándose `orca` (`resources/bin/orca`, `orca.cmd`, `orca.exe`, `~/.local/bin/orca`) porque los skills y terminales de agentes lo invocan así; choca con un Orca instalado en PATH. Renombrarlo es una fase aparte.
- Sigue compartido con Orca: `~/.orca` (agent-hooks, etc.), el proceso `orca-terminal-daemon.exe` que mata el desinstalador de NSIS, el borrado de hooks al desinstalar el último Orca/Zotz, labels de launchd `com.stablyai.orca.*`, y el sidecar de computer use en macOS (`TrustedOrcaApplication.swift` solo confía en `com.stablyai.orca*`). Revisar antes de instalar ambos en la misma máquina.
- Linux deb/rpm: `after-install.sh`/`after-remove.sh` buscan `/opt/Orca`; con productName `Zotz` no registran `/usr/bin/orca-ide` ni ajustan `chrome-sandbox`. No es objetivo (Windows), queda anotado.
- Los links `orca://` (pairing, plugins, skills compartidos) siguen siendo de Orca por regla; Zotz no los recibe del SO.
- En dev (`pnpm dev`) el perfil sigue en `orca-dev` y el bundle id dev es `com.stablyai.orca.dev`.
- Solo se cambiaron ~13 strings de en/es con el nombre de la app; `en.json` tiene ~1,380 menciones de “Orca” en frases (muchas sobre la app móvil oficial, orca.dev o el CLI `orca`). Un reemplazo masivo genera conflictos grandes con upstream; queda para decidir.
- `test:changed` se expande a casi toda la suite (por los JSON de locales); se corrieron los 70 archivos de test relacionados directamente.
- Fallout de CI (PR #3): `pr.yml` (marcador deb/rpm en `/opt/Zotz`, smoke de `Zotz.exe`), harness `tests/tools/win-update-e2e` (D7) y `win-crash-survival-e2e.yml` ahora buscan `Zotz.exe`/`Programs\Zotz`/`%APPDATA%\zotz`. Runtime: el proveedor de navegador de orcad busca primero la instalación de Zotz (Orca como respaldo), `/opt/Zotz` en la inspección del launcher y en `after-install/after-remove.sh`, el desinstalador `Uninstall Zotz.exe` sigue a productName, `Zotz.app` en local builds y el launcher de macOS usa `MacOS/Zotz`. Los e2e `ssh on managed orcad` fallan porque el fork no tiene el tag `v1.4.224` (los fuentes del relay legacy se construyen desde ese tag); hay que publicarlo en origin. `offscreen-browser-backend-frame-rate` es un test de timing no relacionado.
- Segunda ronda de CI: el launcher nativo de Windows (`native/windows-cli-launcher`) buscaba `Orca.exe` fijo; ahora prueba `Zotz.exe` y luego `Orca.exe` (no se pudo compilar localmente: no hay toolchain de Rust en esta Mac, lo valida CI). Se revirtió el `executableName` de Linux a `orca-ide`. `cross-version wire compatibility` sigue fallando porque al fork le faltan tags de release (`v1.4.190`, `v1.4.219`, `v1.4.220`, …), no por el rebrand.

### 2026-11-15 — Fase 2 (`zotz/fase-2-telemetria`, PR #4)

- Nuevo `src/shared/zotz/zotz-network-policy.ts`: features cloud permitidas (`telemetry`, `login`, `relay`, `share`, `connector`, `push`, `github-star`, `agent-state-rules`, `wsl-hosts-policy`). Solo `push` queda permitido mientras Hugo decide (Decisiones abiertas #1).
- Telemetría: `resolveEnvOverride()` siempre regresa `orca_disabled`; `deferStart()` no arma el cliente de PostHog. `mobile-client-telemetry`, `wsl-usage-reporter` y `plugin-install-telemetry` pasan por `track()`, que ya revisa el consent, así que no hizo falta otro guard. El renderer no habla con PostHog: todo pasa por IPC a `track()` en main.
- UI: se ocultan el switch "Share anonymous usage data" (Privacy, que se queda por los diagnósticos locales), el banner de primer arranque y las secciones de Settings `orca-account`, `artifacts` y `share-skills` (también en Cmd+J). `ArtifactPublishButton` no se pinta.
- `getOrcaCloudAuthConfig()` regresa `configured: false` y con eso caen login, relay, connector, artifacts y skills autenticados. Guards extra: relay (`main-process-relay-startup`), connector (`createDesktopConnectorCloud`) y descarga de skills compartidas sin login (`skill-cloud-package-service.withoutAuth`).
- Crashpad ya traía `uploadToServer: false` y no hay `submitURL`; no se tocó.
- Star-nag: al arrancar se marca `starNagCompleted` y ya no consulta a GitHub si diste estrella.
- `agent-state-rules` (bajaba de `github.com/stablyai/orca/releases` cada 4 h) y `wsl-hosts-policy` (igual, solo en Windows) ya no descargan; quedan las reglas incluidas en la app y los overrides locales.
- Tests: el setup de vitest `zotz-vitest-upstream-network-policy.ts` deja la política abierta para que los tests de upstream sigan probando el comportamiento de Orca sin tocarlos; `src/main/zotz/zotz-network-policy-guards.test.ts` la quita y prueba los guards reales (falla si se revierten).
- Pendiente "Listo cuando" (10 min con monitor de red): no se pudo correr aquí.

**Sorpresas / pendientes para Hugo**

- Upstream movió varios servicios a `orca.dev` (no `onorca.dev`). Siguen activos: el sistema de plugins (`pluginSystemEnabled: true` por default) clona `github.com/stablyai/orca-plugins` unos 15 s después de arrancar y, ya con plugins, baja `orca.dev/plugins/kill-list.json` cada 6 h y `orca.dev/plugins/stats.json` al abrir el catálogo. No se cortó porque `main-process-plugins.ts` está en el tope de 300 líneas y porque la kill-list sirve para bloquear plugins maliciosos; conviene decidirlo junto con el auto-update de plugins (Fase 3).
- Updater (`github.com/stablyai/orca` releases y atom, `orca.dev/changelog`, `orca.dev/whats-new/nudge.json`) es de Fase 3; no se tocó.
- Feedback y reportes de crash (`orca.dev/v1/feedback`) solo salen cuando el usuario los manda; se dejaron.
- `mobilePairingConnectionMode` sigue en `'automatic'` por default, pero sin login la UI marca el relay como no disponible y el pairing va local.

### 2026-11-15 — Fase 3 (`zotz/fase-3-updates`, PR #2)

- `src/main/updater/zotz-updater-policy.ts` (nuevo): `isZotzUpdaterEnabled()` (`ZOTZ_ENABLE_UPDATER=1`) y el aviso nativo "Zotz se actualiza con git pull + build" (`dialog.showMessageBox` sobre la ventana principal; sin ventana, solo log). Textos en `en.json` y `es.json` bajo `zotz.updater.*` vía `translateMain`.
- `updater-service.ts` (fachada única del updater): sin el env var, `setupAutoUpdater` no hace nada, así que nunca se carga `electron-updater`, no se registran sus eventos, ni revisión al arrancar, ni timer diario, ni revisión al despertar/enfocar, ni nudges, ni feed de `stablyai/orca`. `checkForUpdates`, `downloadUpdate` y `quitAndInstall` son no-op; `checkForUpdatesFromMenu` (menú, bandeja, botones de Ajustes y tarjeta, todos pasan por ahí vía IPC `updater:check`) muestra el aviso; `listAvailableReleaseBuilds` devuelve `[]` (el selector de canal/build queda vacío); las RPC remotas `check/download/installRemoteServerUpdate` lanzan `remote_update_manual_required` (el mismo código que upstream usa para "actualiza el servicio a mano").
- `serve`: no se auto-actualiza. `setupHeadlessServeAutoUpdater` pasa por la misma fachada; el handoff (`serve-update-handoff.ts`) solo se escribe desde `quitAndInstall`, que está bloqueado, y el supervisor de la CLI (`src/cli/runtime/serve/updates/`) solo reacciona a ese handoff, sin red propia. En Windows además el modo serve ya era `unsupported-headless-serve` (el supervisor es solo de macOS). La CLI no tiene chequeo propio de "update disponible".
- Plugins: `ORCA_PLUGIN_AUTO_UPDATE` ahora es opt-in también en builds empaquetados (antes: `app.isPackaged || env`). Las actualizaciones manuales de plugins siguen.
- Nudges/banners: sin `setupAutoUpdater` el estado del updater se queda en `idle`, y con eso la `UpdateCard`, los nudges y el estado que ven los clientes remotos/móvil no aparecen. No hizo falta tocar el renderer.
- Tests: los 13 tests del updater de upstream cargan la fachada vía `testing/updater-test-module-loader.ts`; ahí se pone `ZOTZ_ENABLE_UPDATER=1` para que el comportamiento de upstream siga cubierto. Nuevo `zotz-updater-policy.test.ts`: sin el env var nada llega a `electron-updater` (falla si se quita el guard).
- `docs/zotz/UPDATE.md`: `git pull` + `pnpm install` + `pnpm build:win` + reinstalar y reiniciar `serve` (manual hoy; tarea programada cuando exista `zotz serve service` en Fase 5).
- Sorpresas: (1) no hace falta tocar `updater-setup.ts`: todos los caminos automáticos (timers, `powerMonitor` resume, `browser-window-focus`, nudges, reintentos) nacen en `setupAutoUpdater` o en eventos que este registra. (2) `orcad-managed-auto-update` (actualiza hosts SSH administrados) se dejó: empuja el orcad **empaquetado en este mismo build de Zotz**, no descarga nada de Orca. (3) Upstream rompía un import (`structural-value-equality`); se resolvió en la base `zotz/fase-0-setup` y esta rama se rebasó encima.
- Pendiente: "Listo cuando" (24 h sin pedir ni instalar updates) solo se puede verificar corriendo el nodo real.
