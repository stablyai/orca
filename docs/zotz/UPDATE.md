# Actualizar Zotz

Zotz **no se auto-actualiza**. El actualizador heredado de Orca descarga releases de `stablyai/orca`, que pisarían el fork y reiniciarían la app a media tarea. Por eso, salvo que se defina `ZOTZ_ENABLE_UPDATER=1`:

- No hay revisión automática de updates (ni al arrancar, ni periódica, ni al despertar el equipo).
- "Buscar actualizaciones" (menú, bandeja, Ajustes) solo muestra el aviso _"Zotz se actualiza con git pull + build"_.
- Descargar, instalar y cambiar de canal/build no hacen nada; la lista de builds sale vacía.
- Un cliente remoto (laptop o móvil) no puede pedirle al nodo en `serve` que se actualice: recibe `remote_update_manual_required`.
- No aparecen nudges ni tarjetas de "update disponible".
- Los plugins no se auto-actualizan salvo que se defina `ORCA_PLUGIN_AUTO_UPDATE=1`.

La lógica vive en `src/main/updater/zotz-updater-policy.ts` y se engancha en `src/main/updater/updater-service.ts`.

## Actualizar el nodo de la MSI (Windows)

En PowerShell, dentro del clon de Zotz:

```powershell
git switch main
git pull --ff-only
corepack pnpm install
corepack pnpm build:win
```

- `build:win` = `build:desktop` (typecheck + `out/`: Electron, CLI, web y mobile-web) + `electron-builder --win`. Deja el instalador NSIS en `dist\`.
- Detén `serve` (ver abajo), ejecuta el instalador nuevo de `dist\` y vuelve a levantar `serve`. El CLI corre dentro del Electron instalado, así que el reinicio es lo que aplica la versión nueva.
- `pnpm build` (= `build:desktop` + `build:native`) sirve para validar el código, pero no produce instalador; `build:native` solo arma addons de macOS.
- Para probar sin instalar: `corepack pnpm build:unpack` deja la app desempaquetada en `dist\win-unpacked\`.

Si `pnpm install` o el build fallan, no reinicies: el proceso que está corriendo sigue usando el build anterior. Arregla, vuelve a construir y entonces reinicia.

## Reiniciar `serve`

El proceso en marcha sigue con el código viejo hasta que se reinicia.

**Cuando exista `zotz serve service` (Fase 5):** reinicia la tarea programada que lo levanta.

```powershell
zotz serve service status
# reinicio de la tarea programada (nombre según lo que registre `zotz serve service install`)
schtasks /End /TN "<tarea de zotz serve>"
schtasks /Run /TN "<tarea de zotz serve>"
```

**Mientras tanto (manual):**

1. Detén el `serve` actual: `Ctrl+C` en la terminal donde corre, o termina el proceso de Zotz desde el Administrador de tareas.
2. Si toca, ejecuta el instalador nuevo de `dist\`.
3. Vuelve a levantarlo con los mismos flags de siempre, por ejemplo `zotz serve --bind <IP-tailscale>` (antes de la Fase 1 el binario se llama `orca`).
4. Desde la laptop o el móvil, confirma que el nodo responde y que la versión es la nueva.

Las sesiones de terminal y agentes que estaban corriendo se cortan con el reinicio: actualiza cuando no haya tareas en curso.

## Reactivar el actualizador de Orca (escape hatch)

Define `ZOTZ_ENABLE_UPDATER=1` en el entorno del proceso de Zotz (la tarea programada o la terminal que corre `serve`) y reinícialo. Vuelve el comportamiento de upstream completo: revisiones automáticas, nudges y descargas desde `stablyai/orca`. Úsalo solo para depurar; un update de Orca reemplaza el build de Zotz.

## Al sincronizar con upstream

Si upstream agrega un camino nuevo que busque, descargue o instale updates (por ejemplo, una función nueva en `updater-service.ts` o un temporizador fuera de `setupAutoUpdater`), pásalo por `isZotzUpdaterEnabled()`. La prueba `src/main/updater/zotz-updater-policy.test.ts` falla si el guard desaparece de los caminos actuales.
