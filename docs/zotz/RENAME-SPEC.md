# Spec — Fase 1c: nombres internos y CLI `zotz`

**Estado:** propuesta (2026-11-17). Se implementa **después** de la Fase 3b ([UPDATES-SPEC.md](./UPDATES-SPEC.md)), así el cambio llega por el actualizador nuevo.
**Relación con el plan:** amplía la Fase 1 y ajusta la regla 3 de `PLAN.md` ("no renombres identificadores internos"). Se renombra lo que **choca con Orca o se ve**; no se renombra lo que solo cuesta y no se ve.

## 1. Objetivo

Que Zotz pueda convivir con Orca instalado en la misma máquina sin pisarse:

- comando,
- carpetas,
- procesos,
- servicios.

Y que Hugo nunca tenga que escribir "orca" para usar Zotz. Sin romper la app móvil oficial ni volver imposible el sync con Orca.

## 2. Inventario (medido en el repo, 2026-11-17)

| Qué                           | Hoy                                                                                                         | Tamaño                                                |
| ----------------------------- | ----------------------------------------------------------------------------------------------------------- | ----------------------------------------------------- |
| Comando de la CLI empaquetada | `orca` (`resources/bin/orca.exe`, `orca.cmd`, `bin/orca` en macOS) y en el PATH del usuario                 | ~25 archivos de skills/recursos lo invocan            |
| Carpeta compartida en el home | `~/.orca` (hooks de agentes, etc.)                                                                          | ~400 archivos la mencionan, mayoría por una constante |
| Procesos                      | `orca-terminal-daemon.exe`, `orca-agent-hook.exe`, `orca-administrator-restart.exe`                         | nombres en builder, NSIS y código de procesos         |
| Servicios de macOS            | etiquetas de launchd `com.stablyai.orca.*`, sidecar de computer use que solo confía en `com.stablyai.orca*` | pocos archivos                                        |
| Linux                         | ejecutable `orca-ide`, `/opt/Zotz`, `after-install.sh`                                                      | pocos archivos                                        |
| Variables de entorno          | `ORCA_*`                                                                                                    | **1,083 distintas, 6,664 usos**                       |
| Paquetes del monorepo         | `@orca/*`                                                                                                   | 4 paquetes, 508 imports                               |
| Protocolo, RPC y pairing      | nombres `orca`, enlaces `orca://`                                                                           | los usa la app móvil oficial                          |

## 3. Nivel 1 — CLI `zotz` (se hace)

1. **Lanzadores con nombre `zotz`:**
   - Windows: `resources/bin/zotz.exe` (el lanzador nativo en `native/windows-cli-launcher` se compila con ese nombre) y `zotz.cmd`.
   - macOS: `bin/zotz`.
   - Linux: `/usr/bin/zotz` y el ejecutable de la app `zotz` en lugar de `orca-ide` (de paso evita el paquete `orca` de GNOME, que es un lector de pantalla).
2. **PATH global:** el instalador solo pone `zotz` en el PATH del usuario. `orca` **sale del PATH global**, así no choca con un Orca instalado.
3. **Compatibilidad dentro de Zotz:** las terminales y agentes que lanza Zotz reciben al frente de su PATH una carpeta interna (`resources/bin/compat`) con un alias `orca` → `zotz`. Así siguen funcionando los skills, plugins y prompts escritos para Orca, que llaman `orca …`, sin exponer `orca` fuera de Zotz.
4. **Textos:** ayuda, errores, skills incluidos (`resources/skills`, `skills/`) y docs de Zotz dicen `zotz …`. `resolveInvokedCliCommand` ya usa `zotz` por default (Fase 1).

## 4. Nivel 2 — lo que choca con Orca (se hace, con migración)

| Qué                  | Cambio                                                                                      | Migración                                                                                                                                                                   |
| -------------------- | ------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `~/.orca`            | `~/.zotz` (una constante en `zotz-app-identity.ts`, usada donde hoy se arma la ruta)        | Al arrancar, si existe `~/.orca` y no `~/.zotz`, se **copia** lo que es de Zotz (hooks, config). No se borra `~/.orca`: puede ser de un Orca instalado.                     |
| Procesos             | `zotz-terminal-daemon.exe`, `zotz-agent-hook.exe`, `zotz-administrator-restart.exe`         | El instalador NSIS cierra **ambos** nombres al actualizar (el daemon viejo sigue corriendo con el nombre anterior).                                                         |
| Hooks de agentes     | Los comandos de hook en `~/.claude/settings.json`, `~/.codex/…` apuntan a `zotz-agent-hook` | Zotz ya reescribe sus hooks al arrancar. Se reconocen y reemplazan los que apuntan al ejecutable viejo **de la instalación de Zotz**; los de un Orca instalado no se tocan. |
| macOS launchd        | `dev.hugorodriguez.zotz.*`                                                                  | Se da de baja la etiqueta vieja si es de Zotz.                                                                                                                              |
| Computer use (macOS) | el sidecar confía en el bundle id de Zotz                                                   | —                                                                                                                                                                           |
| Desinstalador        | solo borra hooks y carpetas de Zotz                                                         | —                                                                                                                                                                           |

## 5. Nivel 3 — no se renombra (y por qué)

| Qué                                                              | Por qué no                                                                                                                                                                                                                                                                                                                                                                                                          |
| ---------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Protocolo, nombres de RPC, pairing, enlaces `orca://` de pairing | La app móvil oficial de Orca y los hosts remotos hablan ese protocolo. Renombrarlo rompe el pairing. Queda así mientras no exista app móvil propia (decisión abierta #2).                                                                                                                                                                                                                                           |
| Variables `ORCA_*` en el código                                  | Son 6,664 usos. No cambian nada visible y cada sync con Orca chocaría en cientos de archivos. En su lugar, **alias**: al arrancar cada proceso (main, CLI, daemon), un shim copia `ZOTZ_X` → `ORCA_X` si `ORCA_X` no está definida. Hugo puede usar `ZOTZ_*` en su máquina y documentación; el código sigue leyendo `ORCA_*`. Un archivo nuevo, `src/shared/zotz/zotz-env-aliases.ts`, más tres líneas de enganche. |
| Paquetes `@orca/*`                                               | Son nombres de módulos internos del monorepo, invisibles fuera del código. Renombrarlos solo genera conflictos de sync.                                                                                                                                                                                                                                                                                             |
| Identificadores, nombres de archivos y clases con "orca"         | Mismo motivo.                                                                                                                                                                                                                                                                                                                                                                                                       |

## 6. Pruebas

- Unit tests:
  - El shim de alias (`ZOTZ_X` llena `ORCA_X` solo si falta).
  - La migración `~/.orca` → `~/.zotz` (copia solo si falta el destino, nunca borra el origen).
  - El reemplazo de hooks (reemplaza los de la instalación de Zotz y no toca los de Orca).
- CI:
  - El smoke de Windows busca `zotz.exe`.
  - El check de nombres falla si vuelve a aparecer `resources/bin/orca` en la configuración del builder.
- Manual (MSI, con y sin Orca instalado):
  - `zotz --help` y `zotz serve --help` funcionan desde una terminal nueva.
  - `orca` **no** existe fuera de Zotz.
  - Dentro de una terminal de Zotz, `orca status` sigue funcionando.
  - Un agente lanzado por Zotz reporta su estado (hooks).
  - Actualizar desde la versión anterior no deja el daemon viejo vivo.

## 7. Riesgos

- **Hooks de agentes:** si el reemplazo falla, los agentes dejan de reportar su estado a Zotz. Mitigación: el test de reemplazo y la prueba manual con los tres agentes.
- **Actualización con el daemon viejo vivo:** el instalador debe cerrar ambos nombres. Lo cubre la prueba manual de §6.
- **Skills de terceros** que llamen `orca` fuera de una terminal de Zotz (por ejemplo, un cron del sistema) dejan de encontrarlo. Se documenta: usar `zotz`.
- **Sync con Orca:** upstream puede agregar referencias nuevas a `resources/bin/orca` o `~/.orca`. Lo cubre el check de CI y la lista de zonas de conflicto en `SYNC.md`.
