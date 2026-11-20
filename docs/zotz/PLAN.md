# Zotz — Plan de trabajo

Zotz es un fork de [stablyai/orca](https://github.com/stablyai/orca) para correr en una MSI con Windows encendida 24/7 como **nodo remoto de agentes**. Hugo le manda tareas a distancia por **Tailscale** y los agentes (**Claude Code, Codex y Antigravity**) trabajan con acceso total a la máquina, sin que Orca ni ningún servicio externo se meta.

> Mascota y logo: un murciélago (_zotz_ en maya). Trabaja de noche, se orienta solo en la oscuridad y le gusta a los devs nocturnos.

---

## Reglas para quien ejecute este plan

1. **Lee `AGENTS.md` antes de tocar nada.** Sus reglas de gates, estilo y multiplataforma aplican aquí.
2. **Una fase por rama/PR**: `zotz/fase-N-<tema>`. No mezcles fases.
3. **Diff mínimo contra upstream.** Vamos a seguir jalando cambios de Orca, así que:
   - Cambia **configuración, defaults y textos visibles**, no renombres identificadores internos en masa.
   - **No renombres** variables `ORCA_*`, paquetes `@orca/*`, nombres de RPC ni el protocolo de pairing. (La Fase 1c renombra solo lo que choca con Orca o se ve: CLI, `~/.orca`, procesos; ver `RENAME-SPEC.md`.) Si lo haces, se rompe la compatibilidad con la app móvil oficial de Orca y cada sync con upstream va a ser un infierno.
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

## Fase 1c — Nombres internos y CLI `zotz`

Spec en [`RENAME-SPEC.md`](./RENAME-SPEC.md). Va después de la Fase 3b para que llegue por el actualizador.

- [ ] CLI `zotz` en el PATH global; `orca` solo como alias dentro de las terminales de Zotz.
- [ ] `~/.orca` → `~/.zotz`, procesos `zotz-*.exe`, etiquetas de launchd, sidecar de macOS y ejecutable de Linux, con migración.
- [x] Alias `ZOTZ_*` → `ORCA_*` al arrancar cada proceso.
- [ ] **No** se renombran protocolo/RPC/pairing (app móvil oficial) ni `ORCA_*`/`@orca/*` en el código (costo de sync).

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

## Fase 3b — Updates desde los releases de Zotz

Reemplaza la regla "Zotz no se auto-actualiza" de la Fase 3: el actualizador de Orca se reapunta a `HugoRodriguezDEV/zotz`. Spec completo en [`UPDATES-SPEC.md`](./UPDATES-SPEC.md).

- [x] CI publica releases versionados `v1.4.<parche×100 + build>` (estables, con `latest*.yml`, `.blockmap` y `zip` de macOS) en vez de `desktop-latest`.
- [x] El actualizador usa `ZOTZ_RELEASE_REPO` en lugar de `stablyai/orca`; changelog y nudges de `orca.dev` apagados; solo canal estable.
- [x] Encendido por default con switch en Ajustes; revisa cada 6 h y descarga en segundo plano; nunca reinicia sola.
- [x] Modo servidor: instala solo tras 10 min sin agentes corriendo ni en cola.
- [x] macOS sin firma: solo aviso con enlace al `.dmg`.
- [ ] Única instalación manual de la primera versión versionada; borrar `desktop-latest`.

**Listo cuando:** un cambio mergeado a `main` llega a la MSI como "Hay una versión nueva", se instala al reiniciar y, en modo servidor, nunca interrumpe a un agente.

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

- [ ] Verificar en Windows que los tres CLIs se detectan (`where claude`, `where codex`, `where agy`) y arrancan en full-access desde terminal **y** desde chat. (Código revisado: un perfil nuevo lanza los tres en full-access en terminal y chat. En la MSI solo está `claude`; faltan instalar `codex` y `agy` y probarlos a mano.)
- [x] Codex: confirmar que full-access implica `--sandbox danger-full-access` y sin aprobaciones, también en `src/shared/agent-launch/permissions/codex-permission-policy.ts`.
- [x] Workspace trust: confirmar que `agent-workspace-trust-decision.ts` / `workspace-pretrust-scope.ts` no frenan a ningún agente con un prompt de "¿confías en esta carpeta?". Si lo hacen, pre-confiar las carpetas de trabajo de la MSI.
- [x] ~~Setting nuevo `zotzVisibleAgents`~~ Reemplazado: se reusa `disabledTuiAgents` de upstream (ya oculta agentes del selector y del auto-launch sin borrarlos del catálogo); `src/shared/zotz/zotz-visible-agents.ts` deja visibles solo `claude`, `codex` y `antigravity`. **No borres** los demás agentes del catálogo; solo ocúltalos.

**Listo cuando:** desde el móvil o la laptop, por Tailscale, lanzas una tarea a cada uno de los tres agentes y la completan sin pedir ninguna aprobación.

---

## Fase 5 — Nodo 24/7 en Windows

Hoy `orca serve service` **no existe en Windows**: `src/cli/server/serve-service.ts:57` lanza _"not available on Windows yet"_. Linux y mac usan `src/cli/runtime/serve/supervision/serve-service-unit.ts`.

### 5a. `zotz serve service` para Windows

- [x] Implementar la variante de Windows en `serve-service-unit.ts`, siguiendo el patrón de las otras plataformas: `install`, `status` y `uninstall`. (Vive en `src/cli/server/zotz-windows-serve-service.ts`, enganchada desde `serve-service.ts`; el XML de la tarea en `src/shared/zotz/zotz-windows-scheduled-task.ts`.)
- [x] Mecanismo: **Tarea programada de Windows** (`schtasks` o `Register-ScheduledTask` vía PowerShell), **no** un servicio de Windows. Un servicio corre en la sesión 0, sin escritorio, y entonces computer use y el navegador no funcionan.
  - Disparador: _al iniciar sesión_ del usuario dedicado.
  - Reiniciar si falla: cada 1 min, intentos ilimitados. (RestartOnFailure llega a 999 como máximo y no vigila la salida del proceso, así que el disparador se repite cada minuto con `IgnoreNew` como watchdog.)
  - Sin límite de tiempo de ejecución.
  - "Ejecutar aunque esté con batería".
- [x] Usar `runProcess` de `@orca/process-host` (ya importado), no `child_process` directo. Leer `docs/agents-md-refs/cross-platform-support.md` antes.

### 5b. Que Windows no se duerma

`src/main/power/` solo tiene asserts de mac (`macos-system-sleep-assertion.ts`) y Linux (`linux-lid-sleep-assertion.ts`).

- [x] Agregar `windows-system-sleep-assertion.ts` con `powerSaveBlocker.start('prevent-app-suspension')` de Electron (o `SetThreadExecutionState` si hace falta más fuerza), y conectarlo en `agent-awake-service.ts`. En modo serve debe estar activo **siempre**, no solo mientras haya un agente corriendo.

### 5c. Script de preparación de la MSI

Crear `resources/win32/zotz/zotz-node-setup.ps1` (el plan decía `scripts/windows/`, pero el guard de la raíz no admite carpetas nuevas) (idempotente, requiere admin, cada paso imprime qué hizo):

- [x] `powercfg`: nunca suspender ni hibernar con corriente, y que cerrar la tapa no haga nada.
- [x] Windows Update: horas activas 0–23 y sin reinicio automático con sesión iniciada (`NoAutoRebootWithLoggedOnUsers`). (Windows acepta máximo 18 h de horas activas: quedan 6:00–24:00, parametrizables.)
- [x] Inicio de sesión automático del usuario dedicado (vía Sysinternals Autologon; documentarlo, no guardar la contraseña en texto plano).
- [x] Instalar y habilitar **OpenSSH Server**, solo con llave (`PasswordAuthentication no`).
- [x] Regla de firewall: el puerto de `zotz serve` y el 22 **solo** desde la interfaz de Tailscale (`100.64.0.0/10`).
- [x] ~~Llamar a `zotz serve service install --bind <IP-tailscale>`.~~ Reemplazado: el script registra la tarea `\Zotz\Server`, que arranca la **app de escritorio en modo servidor** (computer use y navegador necesitan el escritorio; ver `docs/zotz/NODE-SETUP.md`), y no se fija a la IP de Tailscale porque cambia.
- [x] Nota para Hugo, no automatizable: en el BIOS de la MSI, activar _Restore on AC Power Loss_ (o equivalente).

### 5d. Asistente de primer arranque (personal vs. servidor remoto)

La primera vez que se abre Zotz (y después desde Ajustes) pregunta el **modo de la máquina**. Decisiones de Hugo (2026-11-16): se pregunta **al primer arranque**, no en el instalador; en modo servidor se configura **todo de forma automática con un solo permiso de administrador**; si falta Tailscale se **guía e instala**; el autologon **solo se documenta**.

- [x] Setting nuevo `zotzMachineMode: 'unset' | 'personal' | 'server'` (default `'unset'`). Mientras sea `'unset'`, se muestra el asistente. Cambiable en Ajustes.
- [x] **Personal**: no toca el sistema; Zotz se comporta como hoy.
- [x] **Servidor remoto**: detecta el SO y ejecuta los pasos de esa plataforma, mostrando cada uno con su estado (hecho / omitido / falló + por qué). Idempotente: re-ejecutarlo no duplica nada.
  - **Tailscale**: detectar si está instalado y con sesión. Si falta, ofrecer instalarlo (Windows `winget install Tailscale.Tailscale`, macOS `brew install --cask tailscale` o link, Linux script oficial) y esperar a que tenga IP `100.x`. Tomar la IP de Tailscale como dirección de pairing.
  - **Firewall** solo desde `100.64.0.0/10` al puerto del servidor (Windows `New-NetFirewallRule`; Linux `ufw` si está activo; macOS no requiere).
  - **No dormirse**: Windows `powercfg` (sin suspensión/hibernación en corriente, tapa sin acción) + bloqueo de suspensión de 5b; macOS `pmset`/assertion; Linux inhibidor de systemd.
  - **Arranque automático y reinicio si falla**: Windows tarea programada de 5a; macOS LaunchAgent; Linux unidad systemd de usuario (ya existen en `serve-service-unit.ts`).
  - **Exposición de red permanente** en la IP de Tailscale (hoy solo se abre al pulsar "Compartir este equipo").
  - **Enlace de acceso / QR** generado al final, listo para pegar en la laptop o escanear con el móvil.
  - **Autologon (Windows)**: solo instrucciones + link a Sysinternals Autologon; Zotz nunca pide ni guarda la contraseña.
- [x] Todo lo que requiere admin en Windows se agrupa en **un** script (`zotz-node-setup.ps1` de 5c) lanzado con **una** elevación UAC; macOS/Linux usan el diálogo de privilegios del sistema (`osascript … with administrator privileges` / `pkexec`) solo donde haga falta.
- [x] Lógica nueva en archivos `zotz-*` (main: orquestador por plataforma; renderer: pantalla del asistente usando primitivas shadcn de `components/ui` y `docs/STYLEGUIDE.md`); textos en `en` + `es`.

Verificación en hardware real (pendiente; nada de esto se pudo probar desde la Mac de desarrollo, pasos en `docs/zotz/NODE-SETUP.md`):

- [ ] Windows (MSI): el asistente pide una sola UAC y deja ✓ en cada paso; la tarea relanza Zotz al cerrarlo; el enlace/QR conecta desde la Mac y el móvil.
- [ ] Windows: `orca serve service install|status|uninstall` (perfil por defecto).
- [ ] macOS: `pmset` solo pide contraseña si hace falta; el LaunchAgent abre Zotz al iniciar sesión.
- [ ] Linux: regla `ufw` con `pkexec` y la unidad `zotz-server.service` al iniciar sesión.
- [ ] "Listo cuando" de abajo (corte de corriente con Autologon y _Restore on AC Power Loss_).

**Listo cuando:** desconectas y reconectas la corriente, la MSI prende sola, inicia sesión, Zotz levanta en modo serve y en menos de 2 minutos puedes mandarle una tarea por Tailscale.

---

## Fase 6 — Acceso remoto por Tailscale

- [x] ~~`zotz serve` escucha **solo** en la IP de Tailscale de la MSI (`--bind`)~~ Reemplazado: en modo servidor Zotz escucha en todas las interfaces pero **solo admite** loopback y tailnet (`zotz-tailnet-source-guard.ts`), y el firewall de Windows limita el puerto a `100.64.0.0/10` (ver `docs/zotz/REMOTE.md`).
- [x] Pairing directo por la tailnet, sin relay: enlaces/QR del asistente con la IP de Tailscale, o `orca pair --address <IP-100.x>` (ver `src/cli/server/pair.ts`).
- [ ] Probar el pairing desde: (1) la laptop de Hugo con Zotz u Orca, (2) la app móvil oficial de Orca. Si la app móvil oficial no puede parear sin relay, anotarlo en _Decisiones abiertas_.
- [x] Documentar en `docs/zotz/REMOTE.md` cómo conectarse: Tailscale, pairing, SSH de respaldo.

---

## Fase 7 — Higiene de seguridad (acceso total ≠ acceso a todo)

Los agentes tienen acceso total **a la MSI**; que esa máquina no tenga nada que no deba perderse.

- [ ] Usuario de Windows dedicado (`zotz`), sin la sesión de Chrome personal de Hugo y sin datos de negocios ni de clientes. (Pasos en `SECURITY.md` §1; falta hacerlo en la MSI, que hoy corre como `rodri`.)
- [ ] Tokens con alcance mínimo y revocables: GitHub fine-grained, solo con acceso a los repos que el nodo trabaja. (Guía y plan de revocación en `SECURITY.md` §2; lo crea Hugo.)
- [ ] Respaldo: punto de restauración de Windows antes de la primera puesta en marcha y backup semanal de la carpeta de datos de Zotz. (Comandos listos en `SECURITY.md` §3; falta correrlos en la MSI.)
- [x] Documentar todo en `docs/zotz/SECURITY.md`.

---

## Fase 8 — Gobernador de memoria (que Zotz no funda la máquina)

**Objetivo:** Zotz decide **cuántos agentes pueden correr según la memoria real del equipo**. Antes de lanzar un agente mide si cabe; si no cabe, lo pone **en cola** y lo arranca solo cuando otro termine o se libere memoria. Además, cada agente tiene un tope y, si la máquina entra en presión, Zotz **regula**: primero pausa, nunca mata sin permiso.

### Lo que Orca ya trae (reutilízalo, no lo dupliques)

| Pieza                          | Dónde                                                                                                                                                   | Qué hace hoy                                                                                                                                                                                                 | Qué le falta                                                      |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------- |
| Admisión de spawns             | `src/main/daemon/admission/terminal-spawn-gate.ts` + `src/shared/terminal/pty/admission/`                                                               | Limita trabajo **automático**: `automaticConcurrency: 3`, `maxLiveAutomatic: 8` (`DEFAULT_SPAWN_ADMISSION_LIMITS`). Ya tiene **cola de espera** (`terminal-spawn-waiters.ts`, `TerminalSpawnDeferredError`). | Cuenta procesos, no memoria. No aplica a agentes lanzados a mano. |
| Nivel de presión               | `HostPressureLevel = 'ok' \| 'elevated' \| 'critical' \| 'unknown'` en `spawn-admission-contract.ts`, alimentado por `daemon-process-growth-monitor.ts` | Detecta "tormentas" de procesos (descendientes/seg).                                                                                                                                                         | **No mira la RAM.**                                               |
| Pausa por presión              | `AutomaticWorkMode` `{ kind: 'paused', reason: 'pressure' }` en `daemon-automatic-work-guard.ts`                                                        | Pausa trabajo automático cuando hay presión.                                                                                                                                                                 | Se dispara solo por crecimiento de procesos.                      |
| Tope por terminal              | `src/main/daemon/process-scopes/terminal-memory-limits.ts` (`ORCA_TERMINAL_MEMORY_MAX`)                                                                 | Tope duro vía **cgroups**, opt-in, **solo Linux**.                                                                                                                                                           | Nada en Windows ni macOS; no hay UI.                              |
| Árbol de procesos por terminal | `process-growth-breaker.ts` (scopes por terminal)                                                                                                       | Ya agrupa descendientes por terminal.                                                                                                                                                                        | Solo cuenta procesos, no RSS.                                     |

### Decisiones de diseño (2026-11-17)

- **Cola:** FIFO multinivel con relleno y envejecimiento.
  - Tres niveles: manual › remota › automatización. Dentro de cada nivel, orden de llegada.
  - Si la cabeza no cabe, puede entrar el primero de atrás que sí quepa (relleno). Cuando la cabeza lleva 10 min o la rebasaron 3 veces, se le reserva la memoria (envejecimiento).
  - "Pedir cambios" regresa la tarea al frente de su nivel.
  - La cola se guarda en disco y sobrevive reinicios. FIFO puro se descartó: la cabeza bloquea la fila aunque haya memoria para otros, y no tiene prioridades.
  - Estructura de datos en `src/shared/zotz/agent-queue/` y `src/main/zotz/zotz-agent-queue-store.ts`.
- **Las tareas en cola no abren terminal:** la terminal se crea cuando la tarea entra. Así no aplica el límite de 5 min de `createOrAttach` del daemon.
- **Tablero de la cola**, distinto del kanban de agentes de Orca, con columnas por ciclo de vida de la tarea:
  - **Backlog:** la cola real, numerada, con la siguiente tarea resaltada y por qué espera.
  - **In Progress:** corriendo; los pausados se quedan aquí con ⏸.
  - **Review:** el agente terminó; la sesión abierta sigue contando como memoria ocupada, con botón "Liberar memoria".
  - **Done:** su pico alimenta el libro de estimaciones.
  - Arriba, barra de RAM con la línea del mínimo libre.
- **Pausar no libera RAM:** la pausa frena a un agente que crece; lo que protege la máquina es no admitir lo que no cabe.

### 8a. Medir la memoria de verdad

Nuevo `src/main/daemon/admission/zotz-memory-pressure.ts`:

- **Memoria disponible real por plataforma** (no uses `os.freemem()` a secas: en macOS subestima porque no cuenta memoria inactiva o purgable):
  - Windows: `os.freemem()` (equivale a _Available_), y como respaldo `GlobalMemoryStatusEx` si hace falta precisión.
  - macOS: `sysctl kern.memorystatus_level` (porcentaje disponible según el kernel) o `vm_stat` (free + inactive + purgeable + speculative). Reutiliza la lectura de `vm_stat` que ya existe en `src/main/hang-watchdog/hang-incident-snapshot.ts`.
  - Linux: `MemAvailable` de `/proc/meminfo`.
- Leer cada 2 s y solo con agentes vivos o en cola; en reposo, cada 10 s.
- Convertirlo a `HostPressureLevel` con los umbrales de 8d, y **combinarlo con el nivel de crecimiento existente: gana el peor de los dos**. Engánchalo en `daemon-automatic-work-guard.ts`, donde ya se lee `this.monitor.level`.

### 8b. Costo estimado de cada agente

Nuevo `zotz-agent-memory-ledger.ts`:

- Mide el **RSS del árbol completo** de cada terminal de agente (padre + hijos: tests, builds, servidores), reutilizando los scopes por terminal de `process-growth-breaker.ts`.
- Guarda por tipo de agente (`claude`, `codex`, `antigravity`) el **p90 del pico** de las últimas 20 corridas, persistido en el userData de Zotz.
- Sin historial, usa el default de configuración (`agentDefaultReserveGb`, 2.5 GB).

### 8c. Admisión por memoria antes de lanzar

En `terminal-spawn-gate.ts` (y en `openAgentLaunch` de `src/main/agent-launch/agent-launch-executor.ts` para los lanzamientos manuales):

- Un agente entra solo si `disponible − costo_estimado ≥ reserva_minima` y la presión de memoria es `ok`. **Sin tope por cantidad ni presupuesto por agentes** (decisión de Hugo, 2026-11-19): la máquina se aprovecha hasta que la RAM de verdad se carga. `disponible` sale del sistema, así que cuenta todo, también los procesos en segundo plano que lancen los agentes.
- Si no cabe: **en cola**, usando los waiters existentes. Se arranca **en orden de llegada** cuando un agente termina o la memoria se recupera. Nunca se descarta una tarea.
- Aplica a **todos los lanzamientos de agentes** (manuales, automatizaciones, orquestación, remotos por `serve`). **No** aplica a terminales normales sin agente.
- Interruptor "Lanzar de todos modos" por tarea, para cuando Hugo decida forzar.

### 8d. Regulación en caliente

Si con agentes ya corriendo la presión sube:

1. **`elevated`** (disponible < 20 % o < `minFreeGb` + 1 GB): no se admiten agentes nuevos y se avisa (notificación y UI).
2. **`critical`** (disponible < `minFreeGb`), sostenido 30 s: se **pausa el agente más reciente** (macOS/Linux `SIGSTOP` al árbol; Windows `NtSuspendProcess` o suspender el Job Object), se avisa, y se **reanuda solo** cuando el nivel vuelve a `ok` durante 60 s. Un agente a la vez, del más nuevo al más viejo.
3. **Tope por agente rebasado** (`perAgentMaxGb`): según `onAgentOverLimit` = `notify` | `pause` (default) | `kill`. `kill` solo si Hugo lo elige en Settings.

- Nunca pausar ni matar el propio Zotz, el daemon, `tailscaled`, ni la sesión del sistema.
- Ojo: pausar un agente mucho tiempo puede hacer que su sesión con la API expire. Registra en la UI cuánto lleva pausado y, pasados 15 min, avisa para que Hugo decida.

### 8e. Topes duros por plataforma

- **Linux:** ya existe (`ORCA_TERMINAL_MEMORY_MAX`). Solo conectarlo a la configuración de Zotz.
- **Windows:** meter cada terminal de agente en un **Job Object** con `JOB_OBJECT_LIMIT_JOB_MEMORY` = `perAgentMaxGb` y `KILL_ON_JOB_CLOSE`. El spawn de ConPTY está en `src/main/daemon/pty-subprocess/` (`native-pty-spawn-windows`); el Job Object va en el módulo nativo (carpeta `native/`, en Rust) o vía `koffi`/FFI si ya se usa en el repo. **Revisa antes qué hay** para no meter dependencias nuevas.
- **macOS:** no existe un tope duro por proceso para usuarios normales; ahí aplica la regulación suave de 8d (medir, pausar, avisar).

### 8f. Configuración y "al instalar"

Nueva sección **Settings → Recursos** y claves en `src/shared/default-global-settings.ts`:

| Clave                   | Default                | Qué es                                            |
| ----------------------- | ---------------------- | ------------------------------------------------- |
| `minFreeGb`             | max(2, 15 % de la RAM) | Memoria que siempre se deja libre para el sistema |
| `perAgentMaxGb`         | min(6, 35 % de la RAM) | Tope por agente (árbol completo)                  |
| `agentDefaultReserveGb` | 2.5                    | Costo supuesto de un agente sin historial         |
| `onAgentOverLimit`      | `pause`                | `notify` / `pause` / `kill`                       |

- **Primer arranque y `zotz-node-setup.ps1`:** detectar la RAM total, calcular los defaults de la tabla y mostrarlos ("Esta máquina tiene 16 GB: hasta 2 agentes a la vez, 4 GB libres siempre"). Hugo puede ajustarlos ahí mismo.
- Los defaults se calculan una vez y se guardan; no se recalculan si Hugo ya los cambió.

### 8g. Que se vea

- En la barra de estado (ya existe `status-bar/resources/popover/resource-usage-metrics.tsx`): memoria disponible, presupuesto usado por agentes y **agentes en cola**.
- Cada tarea en cola muestra por qué: _"En cola: necesita ~3.1 GB, hay 1.4 GB libres. 2 agentes antes."_
- Notificación (y push al celular si está activo) cuando: un agente entra en cola, arranca desde la cola, se pausa o rebasa su tope.

### Pruebas

- Unit tests **solo** para la lógica pura de admisión y regulación (alimentada con muestras falsas): cabe/no cabe, orden FIFO, reanudación con histéresis (no reanudar y pausar en bucle), p90 del ledger y procesos protegidos nunca tocados.
- Prueba manual documentada en `docs/zotz/MEMORIA.md`: en la MSI, lanzar 6 tareas que corran un script que consuma 3 GB cada una. Resultado esperado: nunca bajan de `minFreeGb`, las que no caben esperan en cola y arrancan solas, y nada se mata.

**Listo cuando:** en la MSI se pueden mandar 10 tareas de golpe por Tailscale y la máquina **no se traba ni entra a swap fuerte**. Las tareas corren por tandas según la memoria y todas terminan.

---

## Decisiones abiertas (las resuelve Hugo)

1. **Notificaciones push al celular** (`push.onorca.dev`): las manda la infraestructura de StablyAI. Opciones: (a) dejarlas, que es cómodo pero los avisos pasan por sus servidores; (b) apagarlas y usar un bot propio de Telegram para los avisos (sería una Fase 8).
2. **App móvil**: ¿usar la app oficial de Orca pareada por Tailscale, o compilar la propia (`mobile/`) más adelante?
3. **Firma del instalador de Windows**: por ahora sin firmar (SmartScreen avisará al instalar). Más adelante se puede usar un certificado propio.

---

## Orden y alcance sugeridos

| Fase                    | Depende de | Tamaño                                 |
| ----------------------- | ---------- | -------------------------------------- |
| 0 Setup                 | —          | S                                      |
| 1 Rebrand + 1b logo     | 0          | M                                      |
| 1c Nombres internos/CLI | 1, 3b      | M                                      |
| 2 Telemetría y red      | 0          | M                                      |
| 3 Updates               | 0          | S                                      |
| 3b Updates desde Zotz   | 3          | M                                      |
| 4 Agentes               | 1          | S                                      |
| 5 Nodo 24/7 Windows     | 1, 3       | L                                      |
| 6 Tailscale             | 5          | S                                      |
| 7 Seguridad             | 5          | S (en su mayoría docs y configuración) |
| 8 Gobernador de memoria | 4, 5       | L                                      |

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

### 2026-11-16 — Fase 5 (`zotz/fase-5-nodo`)

**Qué cambió**

- 5b: `src/main/power/windows-system-sleep-assertion.ts` (`powerSaveBlocker` `prevent-app-suspension`) conectado en `AgentAwakeService`: en Windows, como en macOS, la aserción de sistema sustituye al bloqueo de pantalla (la pantalla se puede apagar; si la aserción falla, se vuelve al bloqueo de pantalla). En modo servidor el modo efectivo es siempre `on` (`resolveZotzComputerAwakeMode` en `src/shared/zotz/zotz-machine-mode.ts`, usado al arrancar y al cambiar settings).
- 5a: `orca serve service` en Windows con la tarea programada `\Zotz\Serve` (al iniciar sesión, token interactivo, repetición cada minuto con `IgnoreNew`, RestartOnFailure, sin límite de tiempo, con batería). Sin `--supervise` (solo POSIX) y solo con el perfil por defecto (una tarea no fija variables de entorno). `resolveServiceCommand` busca `orca.exe` en Windows. El estado sale del enum `State` de `Get-ScheduledTask`, que no depende del idioma de Windows.
- 5c: `resources/win32/zotz/zotz-node-setup.ps1` (idempotente, exige admin, transcripción y JSON de resultado por paso; además quita reglas de bloqueo de `Zotz.exe` en el puerto, como la reparación de firewall de upstream). Se empaqueta en `resources/zotz/` (extraResources de Windows; `resources/win32` ya está excluido de `app.asar`) y el build de Windows de `zotz-desktop-builds.yml` valida que parsea.
- 5d: setting `zotzMachineMode` (opcional en el tipo, default `'unset'`). Pantalla en `src/renderer/src/components/zotz/`, montada en `AppRootSurfaces` junto al onboarding de upstream (sale cuando el onboarding ya no está), con entrada en Ajustes → General. Orquestador en `src/main/zotz/` (fases por plataforma, estado por paso, errores aislados, IPC `zotzNode:*`). Mantener despierta, abrir la red, mostrar el enlace/QR (`mobile:getRuntimePairingUrl` / `mobile:getPairingQR` con la IP de Tailscale leída en vivo) y persistir `zotzMachineMode: 'server'` solo ocurren cuando Tailscale está conectado y el firewall no falló (si se cancela UAC o falla Tailscale/firewall en un equipo personal/sin configurar, no se expone la red ni queda guardado `server`).
- Exposición de red persistente: en modo servidor el escritorio arranca con `exposeNetworkByDefault` y la política de origen de `serve --refuse-public` (cambio de pocas líneas en `main-process-runtime-launch.ts`). No se fija a la IP de Tailscale: cambia al re-registrar el nodo, puede no existir todavía al iniciar sesión, y con una IP fija `ensureNetworkExposure` de upstream rechaza abrir la red y rompe el botón de vincular. El firewall de Windows limita el puerto a `100.64.0.0/10`.
- El arranque automático lanza la **app de escritorio** (`Zotz.exe --zotz-node-autostart`), no `serve` sin ventana: computer use y el navegador necesitan el escritorio, `Zotz.exe` no abre consola y es el mismo perfil con los mismos dispositivos. `shouldActivateDesktopForSecondInstance` ignora ese argumento para que el watchdog no robe el foco.
- Docs: `docs/zotz/NODE-SETUP.md` (qué cambia por SO, cómo deshacerlo, Smart App Control, BIOS, Autologon, cómo probar).
- Tests: XML/args de la tarea y su estado (`zotz-windows-serve-service.test.ts`); secuencia, aislamiento y estado del orquestador y fases con runners inyectados (`zotz-node-setup.test.ts`: una sola elevación en Windows, UAC rechazada, Tailscale instala → login → espera → timeout, macOS sin pedir contraseña si ya está); aserción de Windows en el servicio de awake; `zotz-machine-mode.test.ts`. Fixture `zotz/ZotzMachineModeWizard` para revisar la UI.

**Sorpresas / pendientes**

- Nada de esto se pudo ejecutar en Windows o Linux reales (esta Mac no tiene PowerShell); ver la lista de verificación de Fase 5.
- `RestartOnFailure` del Programador de tareas no vigila la salida de un proceso largo y su `Count` máximo es 999; de ahí el watchdog de repetición cada minuto. Mientras un Zotz abierto a mano (no por la tarea) esté corriendo, la tarea lanza cada minuto un segundo `Zotz.exe` que sale al instante sin activar la ventana; desde el siguiente inicio de sesión es la tarea quien lo posee.
- Windows limita las horas activas a 18 h (no 0–23).
- `-ExecutionPolicy RemoteSigned` (no `Bypass`, por EDR) para el script empaquetado; si el archivo llegara con Mark-of-the-Web, PowerShell lo bloquea y el paso lo reporta.
- Pasar de servidor a personal solo quita el arranque automático; energía, firewall, SSH y políticas se deshacen a mano (comandos en NODE-SETUP.md).
- Homebrew renombró el cask de la app a `tailscale-app`; se intenta ese y luego `tailscale`. En Linux, `tailscaled` rechaza `tailscale login` de un usuario sin privilegios: el asistente lo hace operador con `pkexec tailscale set --operator=<usuario>` antes del login y reporta el error real si el login falla.
- La exposición que abre el asistente adopta en caliente la política de origen de `serve --refuse-public` (`adoptServeNetworkSources` en `runtime-rpc-network-exposure.ts`), sin esperar reinicio.
- La CLI empaquetada sigue llamándose `orca` (`orca.exe`); no se renombró.

**Revisión del PR #7 (2026-11-16)** — arreglos tras code review:

- Elegir "Personal" quita la tarea de arranque siempre que el modo no fuera ya personal: una configuración de servidor a medias (Tailscale falló) podía registrar la tarea sin guardar el modo. Al dejar el modo servidor avisa que los dispositivos emparejados siguen con acceso hasta revocarlos.
- El paso "no dormirse" verifica que un bloqueo del SO quedó activo (`AgentAwakeService.isSleepPrevented`), no solo que se pidió.
- En Windows el bloqueo de sistema es **adicional** al de pantalla (no lo reemplaza): con Modern Standby, apagar la pantalla podía dormir la máquina y sacarla de la tailnet.
- Rechazar el UAC se detecta recorriendo las excepciones internas (`Win32Exception` 1223 / `0x800704C7`), para mostrar "permiso rechazado" en vez del error crudo.
- `orca serve service` en Windows registra la tarea con `S4U` (sin ventana) en vez de `InteractiveToken`: `orca.exe` es de consola y abría una ventana visible en cada inicio de sesión.
- Pendientes anotados, no arreglados: (1) la repetición cada minuto podría relanzar Zotz durante una actualización NSIS (hoy el updater está apagado por Fase 3); (2) `xmlText`/`systemdArgument` duplican escapadores de `serve-service-unit.ts`.

### 2026-11-17 — Fase 4 (`zotz/fase-4-agentes`)

- Permisos: no hizo falta código. Un perfil nuevo trae `agentPermissionDefault: 'full-access'` y en cada lanzamiento se convierte en flags (`claude`/`agy` → `--dangerously-skip-permissions`, `codex` → `--dangerously-bypass-approvals-and-sandbox`) o en política de chat (Codex `never` + `danger-full-access`; Claude con skip-permissions; Antigravity por ACP en modo `yolo`). El `'own'` de `agent-launch-profile.ts:161` solo arma vistas del selector, no pisa el lanzamiento.
- Workspace trust: tampoco hizo falta código. Orca pre-confía la carpeta para Claude (`~/.claude.json`), Codex (`config.toml`) y Antigravity (`~/.gemini/antigravity-cli/settings.json`) justo antes de cada lanzamiento, en cualquier modo de permisos y también en workspaces de carpeta (`agentWorkspaceTrustEnabled`, default `true`).
- Agentes visibles: `applyZotzVisibleAgents` se engancha en los defaults y al cargar el perfil. Guarda en `zotzSeenTuiAgents` qué agentes del catálogo ya vio, así que los que agregue upstream en un sync nacen ocultos y lo que Hugo active o desactive a mano se respeta.

**Sorpresas / pendientes**

- Casos en que un agente sí puede preguntar: Claude cuando la carpeta es la raíz de un disco o el home (`isTooBroadToPreTrust`); Antigravity si arranca en una subcarpeta del workspace (solo confía rutas exactas); escribir `claude`/`codex`/`agy` a mano en una terminal (no pasa por el pre-trust); Codex en WSL; hosts SSH con relay viejo. Para el nodo: abrir cada proyecto como su propio workspace, nunca `C:\` ni la carpeta del usuario.
- Un perfil guardado con `agentYoloDefaultsMigrated: true` pero sin `agentPermissionDefault` cae en `'own'` (sin flags). No pasa con perfiles nuevos de Zotz.
- Antigravity, aun en `yolo`, a veces hace preguntas o pide revisiones administrativas (lo dice su propio spec en `antigravity-acp-launch-spec.ts`).
- La MSI (Katana 15, 16 GB) solo tiene `claude` en el PATH. Falta instalar `codex` y `agy` para cerrar el "Listo cuando".

### 2026-11-17 — Fase 6 (`zotz/fase-6-tailscale`)

- Solo tailnet: `src/main/zotz/zotz-tailnet-source-guard.ts` (`ZotzTailnetOnlySourceGuard`) admite loopback y Tailscale (`100.64.0.0/10`, `fd7a:115c:a1e0::/48`) y rechaza LAN y públicas al aceptar el TCP. Se activa con `zotzTailnetOnly` en las opciones que devuelve `zotzServerNetworkSources` (modo servidor) y se engancha con 3 líneas en `createServeNetworkSourceGuard`, así cubre el arranque y la adopción en caliente del asistente. Antes el modo servidor usaba la política de `--refuse-public`, que también acepta la LAN.
- Firewall (`zotz-node-setup.ps1`): las reglas **Allow** de `Zotz.exe` que Windows crea en el primer "Permitir acceso" (remoto `Any`) dejaban pasar la LAN por encima de la regla de tailnet; ahora se limitan a `100.64.0.0/10` en vez de borrarse (borrarlas haría que Windows vuelva a preguntar).
- Pairing: no hizo falta código. Relay apagado desde Fase 2 y los enlaces/QR del asistente ya usan la IP de Tailscale leída en vivo. Por SSH: `orca pair --address <IP-100.x>` / `orca pair --mobile --address <IP-100.x>`.
- Docs: `docs/zotz/REMOTE.md` (requisitos, vincular laptop/móvil, qué orígenes entran, SSH de respaldo, diagnóstico).

**Sorpresas / pendientes**

- No se usa `--bind <IP-de-Tailscale>` (decisión de Fase 5): la IP cambia y upstream rechaza abrir la red con una IP fija. El filtro por origen + firewall da el mismo resultado.
- `orca serve` sin ventana mantiene la política de upstream (acepta LAN); el nodo no lo usa. Documentado cómo restringirlo.
- Falta la prueba manual: vincular desde la laptop y desde la app móvil oficial por la tailnet, y confirmar que desde la LAN (`192.168…`) se rechaza.

### 2026-11-17 — Fase 7 (`zotz/fase-7-seguridad`)

- `docs/zotz/SECURITY.md`: usuario estándar `zotz` (qué instalar ahí y qué nunca), tokens con alcance mínimo (GitHub fine-grained solo con los repos del nodo y 90 días; cuentas o API keys de agentes solo para el nodo con límite de gasto), qué revocar y en qué orden si el nodo se compromete, punto de restauración antes del asistente y tarea semanal `\Zotz\Backup` (robocopy como `SYSTEM`, sin cachés). Los bloques de PowerShell se verificaron con el parser.
- Sin cambios de código: todo es configuración de la máquina y de las cuentas, que hace Hugo.

**Sorpresas / pendientes**

- Hoy la MSI corre Zotz como `rodri` (el usuario principal) y su carpeta de datos tiene la identidad de pairing (`orca-devices.json`, `orca-e2ee-keypair.json`). Hay que crear `zotz` y mover el nodo ahí.
- Los secretos que Zotz cifra con `safeStorage` (DPAPI) solo se descifran con el mismo usuario en la misma instalación de Windows: un respaldo restaurado en otra máquina obliga a volver a iniciar sesión y a vincular de nuevo.
- Las bases SQLite se copian en caliente (con `-wal`/`-shm`), así que la copia puede no ser consistente. Lo crítico (JSON de configuración y pairing) sí se copia bien.

### 2026-11-17 — Fase 3b (`zotz/fase-3b-updates`)

- **Versiones:** `1.4.<parche×100 + build>` (`zotz-release-version.mjs`). Sin sufijo, para que cuenten como estables. `-zotz.N` se descartó porque el actualizador lo toma como RC, lo ordena por debajo de `1.4.214` y marca error cuando no hay update.
- **CI:** job `version`; builds con `ORCA_LOCAL_BUILD_VERSION`; zip de macOS; los manifiestos y sus archivos se suben con el nombre original (`zotz-stage-release-assets.mjs`) más copias `zotz-*`; release estable `v<versión>` marcado como latest; check `zotz-check-release-repo-refs.mjs`.
- **App:**
  - `ZOTZ_RELEASE_REPO` en el feed, el Atom, `/releases/latest`, la revisión de manifiestos y `MAIN_RELEASE_REPO`.
  - `orca-whats-new` apaga el changelog y los nudges de `orca.dev`.
  - Encendido por default; se apaga con `zotzUpdatesEnabled` (o `ZOTZ_DISABLE_UPDATER=1`).
  - `zotz-update-automation.ts` descarga sola (Windows/AppImage) y, en modo servidor, instala tras 10 min sin agentes trabajando (`getWorkingAgentCount` del servicio de awake). Revisión cada 6 h.
  - Ajustes → Acerca de: switch, `Zotz 1.4.21427 (Orca 1.4.214, build 27)`, sin selector de canales. Ayuda → Changelog/GitHub apuntan a Zotz.
- **Tests:** versión, staging de assets, idle install, lectura de versión y política (con el switch apagado no se carga `electron-updater`). Las fixtures de upstream con URLs de `stablyai/orca` pasan al repo de Zotz.

**Sorpresas / pendientes**

- La automatización solo se activa cuando el arranque de la app la configura; así las suites del actualizador de upstream siguen probando su flujo de "clic para descargar".
- Las builds locales conservan la versión de Orca (`1.4.214`): el actualizador les ofrece el siguiente release de Zotz.
- macOS no tenía el bloqueo de §6: la tarjeta ofrecía "Update" y Squirrel.Mac iba a rechazar el zip. El `Zotz.app` publicado está firmado ad-hoc (`designated => cdhash H"…"`), y un build re-firmado da `code failed to satisfy specified code requirement(s)` con `codesign -v -R`, que es la misma prueba que hace Squirrel. Ahora `zotz-mac-manual-install.ts` marca la versión como `externallyManaged` con `zotzManualDownloadUrl` (el `zotz-macos-arm64.dmg` del release), main rechaza la descarga, y la tarjeta y Ajustes muestran "Descargar la versión nueva". Cuando haya Developer ID, `isZotzManualMacInstall()` debe devolver `false`.
- La base de Orca salía de `package.json`, que Orca no sube en `main` (se quedó en `1.4.214` con Orca ya en `1.4.262`): la etiqueta mentía y el tope de 99 builds nunca se reiniciaba. Ahora es el release más nuevo de Orca cuyo corte está mergeado (§3 de `UPDATES-SPEC.md`); el siguiente release queda en `1.4.25901`.
- macOS se firma con un certificado auto-firmado (`Zotz Release Signing`, gratis). El requisito designado queda `identifier "dev.hugorodriguez.zotz" and certificate leaf = H"…"`: probado aquí, un build re-firmado con otra versión pasa `codesign -v -R` (Squirrel) y con ad-hoc no. CI lo importa (`zotz-import-mac-signing-cert.sh`, confianza con `sudo add-trusted-cert` porque electron-builder solo usa identidades válidas) y revisa `Authority=`. La app lee su firma con `codesign -dvv` al iniciar el actualizador: con certificado usa Squirrel; ad-hoc o desconocida, el `.dmg`.
- Falta la prueba real: instalar a mano `v1.4.21401`, publicar un cambio y ver que llega, se instala al reiniciar y que en modo servidor no interrumpe a un agente.

### 2026-11-17 — Progreso del asistente y marca en textos (`claude/zots-loading-screen-orca-names-ae9160`)

**Qué cambió**

- Asistente de servidor: arriba dice "Paso X de N: <paso>" con el tiempo que lleva, una barra, qué está haciendo el paso actual y una consola con la salida real. En Windows, mientras corre el script elevado, main lee su transcript (`zotz-node-setup.log`) cada segundo (`zotz-node-setup-log-progress.ts`): los pasos que faltan quedan pendientes en vez de todos girando, y la instalación de OpenSSH (5–15 min) dice que tarda.
- El progreso por IPC ahora es `{ steps, output }`; las fases que no son el script escriben líneas con el mismo formato (`== paso ==`, `paso -> done: …`).
- Firewall (`zotz-node-setup.ps1`): limitar a la tailnet la regla Allow de `zotz.exe` fallaba en la MSI ("Aplazar a usuario" solo se puede usar…), porque las reglas que crea el aviso de Windows traen `EdgeTraversalPolicy DeferToUser`. Ahora se cambia a `Block` en la misma llamada (`Set-NetFirewallRule`); el tráfico de Tailscale no usa edge traversal.
- "Orca" → "Zotz" en todos los textos de la interfaz y los menús sin tocar los JSON de upstream: `zotz-brand-copy.ts` se aplica a los catálogos al cargarlos (renderer y main) y a los textos por defecto de `t()`, antes de interpolar. Se conservan "Orca Mobile" / "app móvil de Orca" (la app oficial) y el namespace `zotz.*`. Los tests de upstream lo apagan con `zotz-vitest-upstream-brand-copy.ts`.

**Sorpresas / pendientes**

- Siguen en inglés con "Orca" los mensajes de error armados en main sin `t()` (instalador del CLI, orcad administrado, pairing). Son poco visibles; cambiarlos es editar código de upstream.
- No se pudo abrir la app Electron en la MSI desde el worktree (node-pty no compila sin VS C++); se verificó con capturas de fixtures y con el log real de una configuración en curso.

### 2026-11-18 — Fase 8, parte 1 (`zotz/fase-8-memoria`)

- **Cola (datos):** `src/shared/zotz/agent-queue/`. FIFO multinivel (manual › remota › automatización) con relleno y envejecimiento (10 min o 3 rebases), libro de picos (p90 de 20 corridas), defaults según la RAM y nivel de presión. Persistencia en `zotz-agent-queue-store.ts` (hoy solo la usa el libro de picos).
- **Medición (8a/8b):** `ZotzMemoryGovernorService`.
  - Junta las filas de hooks (agente, estado, workspace) con los PTY locales y mide su árbol completo con `collectMemorySnapshot`. La memoria disponible sale de `collectHostMemory`.
  - Muestrea cada 15 s solo con agentes vivos o tareas en cola, y los cambios de estado de los agentes lo despiertan.
- **Admisión (8c):** `ZotzAgentLaunchQueue` espera en el `admission` de `runPtySpawn`, tanto en los spawns del renderer como en los del runtime, así que cubre UI, CLI, móvil, automatizaciones y orquestación.
  - Prioridad: el renderer cuenta como manual; `mobile` y `cli` como remota; lo demás como automatización.
  - Un remontaje del mismo pane se une a su entrada. Nunca retiene reattach ni restauraciones.
  - Solo admite con una muestra fresca (≤20 s) y presión `ok`.
- **UI (8g):**
  - "En cola" dentro de la pestaña (turno, motivo, Cancelar / Lanzar de todos modos).
  - Indicador en la barra de estado que abre el tablero: barra de RAM y columnas Backlog / In Progress / Review / Done.
  - Switch "Cola de agentes por memoria" en Ajustes → General. Al apagarlo arranca todo lo que esperaba.

**Pendientes (parte 2)**

- Responder pronto a los clientes remotos. Hoy el celular (30–90 s) y la CLI (60 s) marcan "no confirmado" si la tarea espera más, aunque arranque después.
- Persistir las tareas en cola entre reinicios.
- Retener también el chat nativo (`claimStructuredAgentSessionAgent`).
- 8d/8e: pausar con presión crítica (SIGSTOP / `NtSuspendProcess` vía el patch de node-pty) y topes por agente (Job Objects en Windows).
- 8f: Ajustes → Recursos con los límites editables.
- La reserva de un agente recién admitido dura 90 s y puede contarlo dos veces junto a su medición durante ese rato, así que admite de menos, nunca de más.
- Falta la prueba de punta a punta con agentes reales: en la MSI no hay Visual Studio C++ para correr Zotz desde el código.

### 2026-11-18 — Fase 2b: cortar lo que aún llegaba a Orca (`zotz/fase-2b-sin-orca`)

- `zotz-network-policy.ts` suma `plugin-catalog` y `feedback`, ambos apagados.
- **Plugins:** el sistema de plugins sigue encendido. Ajustes → Plugins tiene el interruptor "Descargar el catálogo de plugins de Orca" (`zotzOrcaPluginCatalogEnabled`, apagado por defecto). Apagado, no se siembran ni refrescan `stablyai/orca-plugins` ni `orca-community-plugins` (incluye las fuentes ya sembradas antes), ni se bajan la lista de bloqueo y las estadísticas de `orca.dev`. Los marketplaces que agregue el usuario siguen funcionando. Guardas en `src/main/zotz/zotz-plugin-catalog-guard.ts` (el ajuste se enlaza en `zotz-plugin-catalog-opt-in.ts`, que también arranca o detiene la lista de bloqueo al cambiarlo), enganchadas en los servicios (no en `main-process-plugins.ts` ni `plugin-marketplace-service.ts` más allá de una línea: ya estaban en el tope de 300 líneas).
- **Estrella de GitHub:** `checkOrcaStarred`/`starOrca` ya no llaman a `gh`; Ajustes y la pantalla de inicio ocultan el botón.
- **Comentarios:** "Enviar comentarios" abre `issues/new` del repo de Zotz; `postFeedback` rechaza sin red.
- **Enlaces:** el menú de ayuda pierde Docs, Discord y X. Los avisos de error de terminal y las vistas de proyecto de GitHub apuntan a los issues de Zotz. Se ocultan "Explorar plugins de temas" (onboarding) y la guía de modo administrador en Windows.
- **Textos con "Orca" escritos en el código:** `applyZotzBrandToCopy` se aplica en la salida humana de la CLI (`printResult`, `reportCliError`; el JSON queda intacto) y en `unwrapIpcErrorMessage`, por donde pasan los errores del proceso principal que muestra la interfaz. No toca "Orca Mobile" ni "Orca" dentro de rutas (`~/Orca/x`, `C:\Orca\x`). El comando pair ya dice "Paste this link in Zotz: Settings → Remote Zotz Servers".
- Vistas previas de enlaces (`ZotzLinkPreview/1.0`) y Jira se presentan como Zotz. Los textos de permisos de macOS (`NS*UsageDescription`) dicen "Zotz allows…".
- Sorpresa: `pnpm check:changed` selecciona casi toda la suite (la política de red y el rebrand de textos se importan en todos lados) y las pruebas unitarias llegan al tope de 30 min. Se corrieron acotadas: 1475 pasan; solo falla `process-host-dev-rebuild.test.ts` (espera a un watcher de rolldown en carpetas temporales; no usa nada de esta rama).
- Pendiente: los 17 enlaces de la galería de funciones siguen en `orca.dev/docs` (el título entero es el enlace; hace falta decidir si se quitan o se apuntan a docs propias). El diálogo de comentarios de Orca queda en el código, sin ruta para abrirlo.

### 2026-11-18 — Fase 1c, parte 1 (misma rama `zotz/fase-2b-sin-orca`, por decisión de Hugo)

- **Alias:** `src/shared/zotz/zotz-env-aliases.ts`. Se importa primero en `src/main/index.ts` y `src/cli/index.ts`; los procesos hijos (daemon, terminales) heredan las `ORCA_*` ya llenas.
- **CLI `zotz`:** el comando que se registra es `zotz` en las tres plataformas (`/usr/local/bin/zotz` o `~/.local/bin/zotz`; en Windows el PATH apunta a `resources\bin`, que ahora trae `zotz.exe`/`zotz.cmd`). `orca.exe`/`orca.cmd` de Windows se mueven a `resources\orca-compat`, que solo las terminales de Zotz anteponen al PATH; en macOS y Linux `orca` sigue en `resources/bin`, que no está en el PATH global. El lanzador nativo es el mismo binario (busca `Zotz.exe` dos carpetas arriba, así que funciona desde ambas carpetas).
- Instalaciones y actualizaciones: `zotz-cli-auto-registration.ts` revisa el comando 15 s después del primer arranque de cada versión (`zotzCliRegisteredVersion`) y lo registra si falta, apunta a otra versión o no está en el PATH. En macOS puede pedir la contraseña de administrador para `/usr/local/bin`; si se cancela, no vuelve a preguntar hasta la siguiente versión (queda Ajustes → CLI). Un comando `zotz` ajeno (conflicto) no se toca. El modo serve ya registraba su propia CLI. El enlace viejo `orca` en macOS/Linux sigue apuntando a Zotz hasta que se borre.
- Sin tocar: el nombre del lanzador de Linux (`orca-ide`), la CLI dentro de WSL y el comando que se sugiere a los agentes (`orca`/`orca.cmd`/`orca-ide`, que siguen funcionando dentro de Zotz).
- Falta probar en hardware: `zotz --help` desde una terminal nueva en la MSI y que `orca` ya no exista fuera de Zotz.- **Computer use en Mac:** el ayudante nativo solo confiaba en `com.stablyai.orca*`, así que rechazaba a Zotz (`dev.hugorodriguez.zotz`). Se agregó a `TrustedOrcaApplication.swift`, y `macos-tcc-prompt-watch.ts` también reconoce los diálogos de permisos de Zotz. Falta probarlo en una Mac con la app empaquetada.
- **Decisión (Hugo, 2026-11-18): Zotz no convive con Orca en la misma máquina.** Por eso no se mueven `~/.orca` a `~/.zotz`, ni se renombran procesos (`orca-terminal-daemon`, `orca-agent-hook`), etiquetas de launchd ni el paquete de Linux: sin Orca instalado no chocan y el cambio solo agrega riesgo. Si algún día conviven, ojo: los ganchos de agentes se reconocen por `agent-hooks/<script>` sin mirar la carpeta (`managed-hook-command-matching.ts`), así que cada app pisaría los de la otra; el comando de Codex está congelado (`CODEX_HOOK_COMMAND_FORM`) y obliga a volver a aprobarlo; y las rutas remotas/WSL también usan `.orca`.- **Nombres internos:** `TERM_PROGRAM=Zotz`, el título ante Codex (`clientInfo.title`) y el nombre del tema de Claude Code dicen Zotz. Se dejan los identificadores (`orca_desktop`, `themes/orca.json`) para no perder la selección del tema.
- **Logos:** la tarjeta para compartir usa el murciélago y `github.com/HugoRodriguezDEV/zotz`. Se dejan: la pantalla de la app móvil en Ajustes (muestra la app oficial de Orca, que se queda por regla), `resources/icon-dev.png` (solo builds de desarrollo) y los videos del onboarding (hay que regrabarlos con la interfaz de Zotz).

### 2026-11-18 — Barra lateral simple estilo Conductor (`zotz/sidebar-conductor`)

- Nuevo default `zotzSidebarLayout` (≠ `'orca'`): arriba Inicio / Crear / Buscar; debajo cada proyecto con su `+` (abre el creador de workspaces de upstream con el proyecto elegido) y solo las conversaciones del usuario: sin el checkout principal salvo que tenga pestañas abiertas, sin lo creado por la CLI ni por automatizaciones. Las carpetas sueltas (`~`) salen solo con pestañas abiertas.
- Enganche: un `if` en `components/sidebar/index.tsx`; el resto vive en `components/zotz/sidebar/`. Ajustes → General → "Barra lateral simple" regresa a las tarjetas de Orca.
- Pendiente: el switch "sin worktree" al crear (conversación directa en la carpeta del proyecto), marcar como "propias" las conversaciones abiertas desde Zotz para ocultar agentes externos dentro del mismo worktree, y "Conectar a mi servidor" en modo personal.
- `server-hook-session-binding.test.ts` y `journal-writer-operation-expiry.test.ts` ya fallaban en `main` antes de esta rama.
- Misma rama: cada conversación muestra el `AgentStateDot` de upstream (trabajando, pregunta, error, terminado, sin leer); los proyectos sin ícono toman el avatar de GitHub del dueño. Fase 8: el gobernador mide los chats nativos (pid del dueño en el lease de la sesión) y la cola también los retiene antes de arrancar (`zotz-structured-agent-start-hold.ts`, enganchado en `runStart`).

### 2026-11-18 — Fase 8: prueba de estrés en Zotz Dev (Mac, 32 GB)

- **Tope de agentes:** 6 Claude seguidos → 4 en marcha en ~10 s y el resto en cola (`concurrency`); al cerrar uno, el siguiente arranca solo. Antes del arreglo, la reserva de 90 s contaba doble y dejaba un lugar vacío ese tiempo.
- **Memoria en macOS:** `memory_pressure` cuenta como libre lo que macOS puede mandar a swap; con 16 GB ocupados Zotz seguía viendo 9–12 GB libres. Ahora la presión también sale de `kern.memorystatus_vm_pressure_level` y del swap escrito en 2 min (≥ 1 GiB). Con 12 GB ocupados: presión `elevated`, un Claude nuevo esperó con motivo `pressure` y arrancó solo ~80 s después de liberar la RAM.
- **Cancelar:** la cola resuelve `canceled` y recuerda el pane; la terminal abre como shell sin el agente, con una franja "cancelado en la cola" y la marca en la barra simple. Antes el pane reintentaba el spawn y volvía a la cola.
- **Pendiente:** repetir la prueba de memoria en la MSI (Windows mide distinto).
- **CI del PR #18:** las suites E2E de upstream (D7 de Windows y el layout oracle) buscan el botón "New workspace" de la barra de Orca. Con `ORCA_E2E_USER_DATA_DIR` (lo ponen los drivers de e2e) y sin `zotzSidebarLayout` elegido, la barra vuelve a la de Orca (`isZotzConductorSidebar(settings, automatedLaunch)`), igual que el asistente de primer arranque. La barra nueva leía `folderWorkspaces`/`worktreesByRepo` directo; ahora usa los selectores del ratchet. El oráculo de apagado de serve en Linux busca `~/.local/bin/zotz`.
- Bajo `ORCA_E2E_USER_DATA_DIR` también se permite el catálogo de plugins de Orca: las suites e2e de upstream instalan desde él. `plugin-demo.spec.ts` espera "control Zotz".
- **Pendientes del CI que no son de este PR:** (1) el D7 empaquetado de Windows falla igual en `main` (corrida manual 44378985670): a la app instalada le falta `out\shared\orchestration\orchestration-compatibility-evidence.js` y `zotz serve` no arranca; el último verde fue el 2026-11-17, así que lo rompió algo que entró a `main` después. Hay que investigarlo antes de depender de `zotz serve` en la MSI. (2) `cross-version wire compatibility` toma como release anterior el tag de Zotz `v1.4.25901` y su copia no arranca el worker de journal SQL en el harness; nunca había corrido en el fork. (3) Los jobs de macOS (persistence, smoke nativo, updater) no consiguen runner.

### 2026-11-18 — Checks unificados y release solo Zotz (`zotz/pr-checks-unificados`)

- **Checks:** la franja de Zotz con el PR y sus checks salía arriba de Source Control y repetía el panel de Checks de upstream (PR, checks, comentarios, "Fix with AI"). Se quitó; el interruptor de Autofix vive ahora en el panel de Checks (`ZotzChecksAutofixToggle`, arriba de la lista). El Autofix sigue corriendo desde `useZotzPrChecksMonitor`, que también usa el chip del PR bajo la conversación. Se fueron con la franja: "Create PR" por el agente y el botón Merge de la franja (el panel de Checks de upstream ya tiene los suyos).
- **Release:** `zotz-stage-release-assets.mjs` publica cada instalador solo con su nombre `zotz-*` y reescribe los `latest*.yml` para que apunten a él (con su `.blockmap`). El build conserva los nombres `orca-*` porque el CI de upstream los lee. Los workflows de release de Orca (`release-cut`, `release-mac-build`, `release-policy`) no corren en el fork: se disparan a mano o tienen el guard `github.repository == 'stablyai/orca'`.
- El actualizador se apaga bajo `ORCA_E2E_USER_DATA_DIR` (ya en `main`): el D7 empaquetado de Windows fallaba porque el build viejo de la prueba se actualizaba al release real mientras arrancaba `serve`.

### 2026-11-19 — Pestaña "Segundo plano" (`zotz/segundo-plano`)

- Los procesos en segundo plano de la sesión (pruebas, scripts, subagentes) ya no salen como franja arriba del chat: la franja de upstream (`NativeChatStructuredSessionStatus`) se monta por portal dentro de la pestaña nueva **Segundo plano** de la barra derecha (`zotz-background`, ícono Activity), con su lista y su Detener tal cual.
- Solo el chat visible y enfocado llena la pestaña; sin tareas (o sin chat nativo) muestra un estado vacío. Con la pestaña cerrada no se muestra en ningún lado.
- Archivos: `components/zotz/background/` (destino del portal, portal y panel). Ganchos de pocas líneas en `use-structured-native-chat-subagents.tsx` (envuelve la franja; `NativeChatStructuredSession.tsx` ya está en el tope de 400 líneas), la unión `RightSidebarTab` y sus tres validadores (ruta del renderer, parámetros RPC, normalización persistida), los ítems de la barra y el contenido de paneles.
- **Salida de los shells:** en el panel, una fila de shell (`command`/`monitor`) se despliega con la cola de su salida (últimas 200 líneas o 64 KB), refrescada cada segundo mientras la tarea sigue viva. Las filas de agente siguen abriendo su conversación. El archivo sale del `outputFile` que Claude Code publica en los bloques `background-task` del transcript (`zotz-background-task-outputs.ts`) y se lee por el host del worktree del chat: rangos con acceso `user-file` en local/SSH/WSL, y el permiso de archivo del host (`readHostFilePreview`) en servidores remotos. Sin `outputFile` (Codex y otros) el despliegue lo dice. Fuera del panel la franja no cambia (el contexto solo existe dentro del portal).

### 2026-11-19 — Revisar cambios antes de borrar o quitar (`zotz/borrar-con-revision`)

- **Borrar conversación/worktree:** upstream ya contaba los cambios sin commitear y listaba los archivos en un popover. Ahora cada archivo de esa lista se despliega con su diff contra HEAD (`ZotzDirtyFileDiff`, unificado con `structuredPatch` de `diff`, hasta 200 líneas). El diff se pide por `getRuntimeGitDiff` con el contexto de `getEditorFileReadContext`, así que funciona igual en local, SSH y WSL. Gancho: prop `owner` en `DeleteWorktreeDirtyChangeHint` (tres llamadas). Los folder workspaces no cambian: upstream no revisa cambios en ellos.
- **Quitar proyecto:** solo lo desregistra (los archivos y worktrees se quedan en el disco o en el host remoto; se cierran sus terminales y ya avisaba de archivos sin guardar del editor). `ZotzProjectRemovalChanges` revisa las conversaciones del proyecto con la misma hidratación de estado del diálogo de borrar y lista las que tienen cambios sin commitear, con sus archivos y diffs, antes de confirmar. El aviso dice "N cambios sin commitear" (prop `keptLabel`), no "se perderán".
- Sin verificar en local: las dependencias compartidas (`node_modules` de grunt) quedaron con enlaces rotos tras una reinstalación del 2026-11-19, así que no corrieron vitest, los plugins de oxlint ni `check:code-quality:changed`; los cubre el CI del PR. Sí pasaron `pnpm tc`, oxfmt, oxlint base, los ratchets de max-lines y workspace-record-read, y la extracción, cobertura y catálogos de traducciones.

### 2026-11-19 — Fase 8: ver qué espera en la cola (`memory-limiter-backlog-indicador`)

- Un chat nativo retenido por la cola no decía nada: el agente se quedó ~20 min en Backlog sin que se notara. Ahora el chat muestra la misma tarjeta "En cola" que la terminal, arriba del compositor (`ZotzQueuedChatNotice`, una línea en `NativeChatStructuredSession`). Se busca por la llave canónica de la sesión, sin importar qué pestaña la muestre.
- Barra lateral simple: la conversación con un agente en cola lleva un reloj de arena y "En cola · N min" en color de pendiente, por encima del estado de sus hilos.
- La tarjeta dice cuántos minutos lleva esperando.
- **Por qué esperó con RAM de sobra:** el tope de agentes simultáneos (4 con 32 GB, 2 con 16 GB) contaba a todos los agentes con sesión abierta, también los que esperaban respuesta. Con 4 chats abiertos, el quinto se quedaba en cola por `concurrency` aunque sobrara memoria.
- **Decisión (Hugo, 2026-11-19): solo decide la RAM.** Se quitaron el tope por cantidad (`maxConcurrentAgents`) y el presupuesto del 70 % para agentes (`agentBudgetBytes`). Un agente entra si, después de su costo estimado, quedan libres `minFreeGb` (max(2 GB, 15 %)) y la presión es `ok`; si no, espera y arranca solo cuando se libera memoria (muestra cada 15 s mientras haya cola). La memoria disponible la reporta el sistema, así que incluye los procesos en segundo plano de los agentes.
- Para que una ráfaga no llene la RAM: un agente admitido aparta durante 90 s lo que le falta de su estimación (estimación − lo medido), porque al arrancar mide poco. Antes la reserva se soltaba con la primera medición y el tope por cantidad tapaba el hueco.

### 2026-11-19 — Archivar conversaciones principales y cola de memoria por servidor (`zotz/servidores-cola-y-archivar`)

- Spec: [`SPEC-servidores-cola-y-archivar.md`](./SPEC-servidores-cola-y-archivar.md). Parte A en este PR; Parte B (cola de memoria de los servidores visible y controlable desde la laptop) en PRs siguientes.
- **Archivar la conversación principal de un proyecto** (por ejemplo `uni` en la MSI): el menú ofrecía Archive y Delete solo fuera del checkout principal, así que para esa fila no existían. Ahora Archive también aparece en principales; Delete sigue bloqueado. La sección Archivadas ya lista las principales, y se restauran desde ahí.
- `archiveZotzConversation` ignoraba el resultado de `updateWorktreeMeta` y avisaba "Conversation archived" aunque fallara. Ahora manda el host de la conversación y, si falla, muestra el error sin "Deshacer".
- Sin cambio en `useArchiveOnMerge`: una principal nunca se archiva sola al hacer merge.
- Sin verificar con la MSI real; se comprobó con la fixture `ZotzProjectSidebar:archivedMain`.

### 2026-11-20 — Cola de memoria de los servidores, lectura (`zotz/cola-servidores-lectura`)

- Spec: [`SPEC-servidores-cola-y-archivar.md`](./SPEC-servidores-cola-y-archivar.md), Parte B. La laptop ahora ve la cola de memoria de cada servidor emparejado.
- **Servidor:** llamadas RPC nuevas `zotz.agentQueue.snapshot` y `zotz.agentQueue.subscribe` (permiso `workspace`) y la capability `zotz.agent-queue.v1`. El constructor del snapshot salió del IPC de Electron (`zotz-agent-queue-snapshot-builder.ts`) y el limitador se registra en `zotz-agent-queue-source.ts`, para que un servidor sin escritorio también pueda atenderlo. Solo se agregan llamadas.
- **Cliente:** `zotz-host-agent-queue-store.ts` sigue la cola de cada servidor que declare la capability y olvida el que se desconecta; lo que llega de otra máquina se valida entrada por entrada (`zotz-agent-queue-remote-snapshot.ts`). Se monta en `use-app-shell-services.ts`.
- **Interfaz:** el aviso de cola del chat de un servidor sale con "En {servidor}" y sin botones (cancelar y _Launch anyway_ son la PR 3); la barra lateral une la cola local con la de los servidores para el reloj de arena y "En cola · N min".
- **Compatibilidad:** un servidor sin la capability no muestra cola y no da errores. Para ver la cola de la MSI, la MSI debe tener este release.
- **Sin cubrir todavía:** tarjetas sobre terminales de un servidor y tablero por máquina. No se verificó con la MSI real.

### 2026-11-20 — Cola de memoria de los servidores, acciones (`zotz/cola-servidores-acciones`)

- Spec: [`SPEC-servidores-cola-y-archivar.md`](./SPEC-servidores-cola-y-archivar.md), Parte B, fase 3. Desde la laptop se puede cancelar un arranque en cola de un servidor o pulsar _Launch anyway_.
- **Servidor:** llamadas RPC nuevas `zotz.agentQueue.cancel`, `forceStart` y `dismissCanceled` (permiso `workspace`, id de 1 a 1024 caracteres, igual que el IPC de la ventana) y la capability `zotz.agent-queue-control.v1`, aparte de la de lectura porque un servidor que publica su cola puede no tener todavía estas llamadas. En un servidor sin limitador no hacen nada ni fallan.
- **Cliente:** `zotz-host-agent-queue-actions.ts` llama al servidor y, si falla, avisa con el nombre del servidor; no actualiza nada a mano porque el flujo de la cola del servidor reporta el resultado. Los botones del aviso del chat de un servidor salen solo si declara la capability de control.
- **Sin cubrir todavía:** tarjetas sobre terminales de un servidor (falta comprobar que la clave de panel coincide) y el tablero por máquina. No se verificó con la MSI real.

### 2026-11-20 — Cola de memoria de los servidores, terminales (`zotz/cola-servidores-terminales`)

- Un agente de terminal lanzado en un servidor y retenido por su limitador no mostraba nada en la laptop: la tarjeta "En cola" del pane solo leía la cola local. Ahora lee la cola del servidor dueño del worktree, con "En {servidor}" y Cancelar / _Launch anyway_ si el servidor declara la capability de control; la franja de cancelado también.
- **Clave de panel:** el servidor recibe el `tabId`/`leafId` de la laptop en `terminal.create` y `terminal.createAgentSession` y los conserva, así que la cola lo guarda con la misma clave que calcula la ventana.
- `use-zotz-queue-on-host.ts` reúne cola, nombre y acciones de la máquina (local o servidor) para el chat y la terminal.
- **Tablero de todas las máquinas:** una sola tabla (Backlog / In Progress / Review / Done) con las tarjetas de todas las máquinas; arriba, una línea de memoria por máquina (esta primero, con "Este equipo"). Cada tarjeta lleva la marca de su máquina (ícono de equipo o servidor y nombre) cuando hay más de una. En el backlog, cada máquina conserva su turno y las siguientes de cada una quedan juntas arriba. Un servidor sin la capability de control no muestra botones y una línea arriba dice que hay que actualizarlo. El contador "en cola" de la barra de estado suma todas las máquinas; la RAM libre sigue siendo la de esta.
- **Panel lateral, no diálogo:** el tablero se abre junto a la barra lateral, sin bloquear la app, como el Workspace board y el de Agents (`ZotzAgentQueueDrawer`, montado en `sidebar/index.tsx`). Abrir uno cierra los otros dos; Escape, la X o el botón de la barra de estado lo cierran.
- **Memoria libre en macOS:** el limitador usaba el "free percentage" de `memory_pressure` (heredado de Orca), que cuenta como libre lo que el kernel recuperaría comprimiendo o paginando: con 10 GB en swap marcaba 15 GB libres de 24 cuando Monitor de Actividad dejaba ~8. Ahora toma el menor entre ese número y lo que queda fuera de "Memoria usada" (apps + wired + comprimida, de `vm_stat`), tanto para mostrar como para admitir agentes (`collectZotzHostMemory`). El monitor de recursos de Orca no cambia.
- **Pendiente:** un agente lanzado desde la laptop en un servidor entra con prioridad `automation` (la más baja), porque el servidor solo reconoce `mobile`/`cli` como remotos.
- **Riesgo abierto:** la laptop espera la respuesta de crear la terminal remota ~3 min (`REMOTE_RUNTIME_AUTO_RECOVERY_TIMEOUT_MS`); si el agente sigue en cola más tiempo, el pane se da por desconectado. Falta que una espera en cola no cuente como caída.

### 2026-11-20 — Marca de segundo plano y sin archivar al hacer merge (`zotz/sonar-segundo-plano`)

- **Marca propia para el segundo plano:** cuando el agente terminó y solo sigue un proceso en segundo plano (estado `monitoring`), la barra lateral mostraba la misma onda que con el agente trabajando. Ahora muestra `ZotzBackgroundSonar` (un punto con dos arcos de eco que pulsan). La onda queda solo para `working`, que siempre gana: si en la conversación el agente trabaja y además hay un proceso en segundo plano, se ve la onda.
- **Se quita `useArchiveOnMerge`:** una conversación ya no se archiva sola al mergear su PR; solo Hugo la archiva desde el menú. También salió la cadena `zotz.sidebar.archivedMerged`. La limpieza automática de upstream (`workspaceCleanup`) sigue apagada por defecto y no se tocó.
- Verificado con la fixture `ZotzWorkingRipple:backgroundOnly`; no se probó con un proceso real en segundo plano.
