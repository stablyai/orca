# Spec — Fase 3b: Zotz se actualiza desde sus propios releases

**Estado:** propuesta aprobada por Hugo (2026-11-17), por implementar en `zotz/fase-3b-updates`, **antes** de la Fase 8.
**Reemplaza:** la regla de la Fase 3 "Zotz no se auto-actualiza" (`ZOTZ_ENABLE_UPDATER`).

## 1. Objetivo

Que cada versión que se publique en `HugoRodriguezDEV/zotz` llegue sola a las instalaciones de Zotz. Debe:

- Avisar que hay versión nueva, descargarla en segundo plano e instalarla al reiniciar.
- **Nunca** reiniciar la app por su cuenta mientras hay trabajo corriendo.
- No volver a hablar con `stablyai/orca` ni con `orca.dev`.

Fuera de alcance: firma de código (decisión abierta #3) y canales hourly/daily/adhoc.

## 2. Qué existe hoy

- El actualizador de Orca (`src/main/updater/`, unas 5,400 líneas sobre `electron-updater`) ya hace todo el ciclo: revisar, descargar, avisar en la tarjeta de updates y la barra de estado, instalar al salir, posponer instalaciones en `serve`, etc.
- Fase 3 lo apagó: sin `ZOTZ_ENABLE_UPDATER=1`, `updater-service.ts` no lo inicia.
- El workflow `zotz-desktop-builds.yml` publica un único prerelease `desktop-latest`:
  - Versión siempre `1.4.214`.
  - Instaladores renombrados (`zotz-windows-x64-setup.exe`, …).
  - Sin manifiestos (`latest*.yml`) ni `.blockmap`.
  - Con eso el actualizador nunca vería una versión nueva.

### Cómo decide el actualizador que hay versión nueva

1. Lee el feed Atom de releases del repo, ordena las etiquetas por semver y se queda con la más nueva que sea `> app.getVersion()`.
2. Revisa que esa etiqueta esté **lista**: descarga el manifiesto de su plataforma (`latest.yml` en Windows, `latest-linux.yml`, `latest-mac.yml`) y hace HEAD a cada archivo que menciona.
3. Si no hay nada más nuevo, resuelve `/releases/latest` (que debe ser un release **estable**) para que `electron-updater` responda "no hay update". Si no existe un estable listo, lo reporta como error y reintenta.
4. Una versión con sufijo (`-rc.N`, `-zotz.N`) se trata como prerelease: cambia el canal a RC, fuerza revisar prereleases y se ordena **por debajo** de la misma versión sin sufijo.

## 3. Versiones

**Formato:** `MAJOR.MINOR.PATCH`, sin sufijo, con

```
PATCH = parche_de_Orca × 100 + build_de_Zotz       (build_de_Zotz = 1..99)
```

| Orca base | Build de Zotz | Versión   | Etiqueta     |
| --------- | ------------- | --------- | ------------ |
| 1.4.214   | 1             | 1.4.21401 | `v1.4.21401` |
| 1.4.214   | 27            | 1.4.21427 | `v1.4.21427` |
| 1.4.230   | 1             | 1.4.23001 | `v1.4.23001` |

Por qué:

- **Sin sufijo:** cuenta como estable. No activa el canal RC, `/releases/latest` funciona y no se ordena por debajo de nada.
- **Siempre sube**, también al sincronizar con Orca: `1.4.23001 > 1.4.21427`.
- **Cabe en Windows:** cada parte de la versión del ejecutable es de 16 bits (≤ 65535). `parche × 100 + 99` aguanta hasta Orca `x.y.654`.
- **Se lee la base:** `1.4.214·27` es Orca 1.4.214, build 27 de Zotz.
- La compatibilidad con la app móvil y los hosts remotos usa números de protocolo (`src/shared/protocol-version.ts`), no la versión de la app. Los rangos `engines` de plugins siguen funcionando: la versión de Zotz es mayor o igual a su base.

**Cálculo en CI:**

1. Base = `version` de `package.json` (la de Orca; no se edita a mano).
2. `build` = (número de etiquetas `v<major>.<minor>.<parche×100 + n>` ya publicadas para esa base) + 1.
3. Si `build > 99`, el job falla con un mensaje claro (sincroniza con Orca o cambia el esquema).
4. La versión se inyecta al empaquetar (`extraMetadata.version`, sin tocar `package.json` del repo). La app la ve en `app.getVersion()`.
5. Ajustes → Acerca de muestra: `Zotz 1.4.21427 (Orca 1.4.214, build 27)`.

## 4. Publicación (CI: `zotz-desktop-builds.yml`)

En cada push a `main` que cambie código (los cambios solo de `docs/**` y `*.md` no publican, como hoy):

1. Calcular la versión (§3) **una vez**, en un job previo, y pasarla a los tres builds.
2. Construir:
   - Windows: `nsis` x64 → instalador + `.blockmap` + `latest.yml`.
   - Linux: `AppImage` + `deb` x64 → archivos + `latest-linux.yml`.
   - macOS: `dmg` **y `zip`** arm64. El `zip` es el que genera `latest-mac.yml` y el que usa el actualizador de macOS.
   - `--publish never`, como hoy. `electron-builder` genera los manifiestos igual porque hay configuración de `publish`.
3. Subir los archivos **con el nombre que dicen los manifiestos**. Si se renombran, el actualizador ve 404 y la versión queda "no lista" para siempre. Para humanos se agregan además copias con nombre claro (`zotz-windows-x64-setup.exe`, …).
4. Crear el release `v<versión>`:
   - **No** prerelease y marcado como _latest_.
   - Con notas generadas de los commits desde la etiqueta anterior (`--generate-notes`).
5. Si un build de una plataforma falla o se cancela (pasa con los runners macOS arm64 de GitHub), el release se publica igual con las demás. El manifiesto de la plataforma que falta no existe, y en esas máquinas el actualizador simplemente no ve esa versión: no rompe nada.
6. `desktop-latest` deja de publicarse. Se borra una vez, a mano, cuando salga el primer release versionado.

## 5. La app

### 5.1 Repo y URLs

- Nueva constante `ZOTZ_RELEASE_REPO = 'HugoRodriguezDEV/zotz'` en `src/shared/zotz/zotz-app-identity.ts`.
- Se usa en lugar de `stablyai/orca` en:
  - `src/shared/release-channel.ts`: `MAIN_RELEASE_REPO`. Mueve también los enlaces de "notas de la versión" y el selector de builds.
  - `src/main/updater/lifecycle/updater-setup.ts:174` (feed inicial).
  - `src/main/updater/releases/updater-release-readiness.ts:4,110`.
  - `src/main/updater/releases/updater-prerelease-feed.ts:15,20,72,78` (Atom, regex de etiquetas y `/releases/latest`; el repo se escapa en las regex).
  - `config/dev-app-update.yml` (owner, repo y carpeta de caché `zotz-updater`).
- Los canales hourly/daily/adhoc/RC se **ocultan** en Ajustes → Updates (`ReleaseChannelSection.tsx`). Solo existe "Estable".
- Un check en CI (`grep`) falla si vuelve a aparecer `stablyai/orca` en `src/main/updater/` o `src/shared/release-channel.ts` después de un sync con Orca.

### 5.2 Lo que se apaga

- **Changelog** de `orca.dev/whats-new/changelog.json` y **nudges** de `orca.dev/whats-new/nudge.json`: apagados por la política de red (features `orca-changelog`, `orca-nudges`, no permitidas). La tarjeta de update ya soporta `changelog: null`. "¿Qué hay de nuevo?" abre las notas del release de Zotz.
- Enlaces de ayuda del menú (`SidebarSettingsHelpMenu.tsx`): "Changelog" y "GitHub" apuntan a los releases y al repo de Zotz.

### 5.3 Encendido y red

- Encendido **por default**. Un switch en Ajustes → Updates, "Buscar y descargar versiones nuevas de Zotz" (setting `zotzUpdatesEnabled`, default `true`), lo apaga.
- `ZOTZ_ENABLE_UPDATER` desaparece. Para las pruebas de upstream, el loader de tests sigue forzando el actualizador encendido.
- Política de red (`zotz-network-policy.ts`): nueva feature permitida `zotz-updates`. Solo cubre `github.com/HugoRodriguezDEV/zotz/releases*`, `objects.githubusercontent.com` (descarga de los archivos) y `api.github.com/repos/HugoRodriguezDEV/zotz/releases` (selector de builds). Con el switch apagado, nada de esto se consulta.

### 5.4 Cuándo revisa, descarga e instala

| Momento                  | Comportamiento                                                                                                                                                                                                                         |
| ------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Revisar                  | Al arrancar, y luego **cada 6 h** (Orca: 24 h). También al despertar el equipo o enfocar la ventana, si ya pasaron 6 h. Los reintentos por error siguen el backoff de Orca (1 h → 6 h).                                                |
| Descargar                | **Automática** en segundo plano en Windows y AppImage (`autoDownload = true`; Orca pide clic). En macOS y en `deb`, solo el aviso con enlace (ver §6).                                                                                 |
| Avisar                   | Tarjeta "Hay una versión nueva de Zotz (1.4.21427)" con **Reiniciar para actualizar** y **Ver qué cambió**. También en la barra de estado.                                                                                             |
| Instalar (personal)      | Solo cuando tú le das "Reiniciar para actualizar", o al cerrar Zotz (`autoInstallOnAppQuit`). Nunca reinicia sola.                                                                                                                     |
| Instalar (modo servidor) | Cuando la versión ya está descargada **y** no hay agentes corriendo ni en cola durante 10 min seguidos: instala y la tarea `\Zotz\Server` relanza Zotz. Si llega trabajo antes, espera. Con agentes corriendo, solo si tú le das clic. |

La regla del modo servidor vive en un archivo nuevo, `src/main/updater/zotz-server-idle-install.ts`. Usa el conteo de agentes vivos y, cuando exista, la cola de la Fase 8. Se engancha en pocas líneas donde el actualizador marca `downloaded`.

## 6. Por plataforma

| Plataforma     | Auto-update | Notas                                                                                                                                                                                                                                            |
| -------------- | ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Windows (NSIS) | Sí          | Sin firma funciona: no hay `publisherName`, así que `electron-updater` no exige firma. **No** agregar `publisherName` después sin plan: rompería los updates de las versiones ya instaladas. SmartScreen solo aparece en instalaciones manuales. |
| Linux AppImage | Sí          | Se reemplaza solo.                                                                                                                                                                                                                               |
| Linux deb      | No          | Orca ya trae este flujo: descarga y muestra cómo instalarlo con el gestor de paquetes.                                                                                                                                                           |
| macOS          | No          | `Squirrel.Mac` exige que la versión nueva tenga la misma firma que la instalada, y los builds sin certificado no la tienen. Se desactiva la instalación y queda el aviso con enlace al `.dmg`. Se reactiva cuando haya certificado.              |

## 7. Pruebas

- **Unit tests**, solo de lógica nueva o reglas propias:
  - Cálculo de la versión (base 1.4.214 + builds publicados → `1.4.21427`; `build > 99` falla).
  - La regla de instalar en servidor: no instala con agentes, sí después de 10 min sin agentes, se reinicia el conteo si llega trabajo.
  - Con `zotzUpdatesEnabled = false` no se carga `electron-updater`.
- **Tests de upstream** que comprueban URLs de `stablyai/orca`: se actualizan al repo de Zotz (mismo comportamiento, otro repo).
- **Prueba real** (manual, documentada en `UPDATE.md`):
  1. Instalar la primera versión con Fase 3b (a mano, ver §8).
  2. Hacer un cambio trivial en `main` y esperar su release.
  3. Comprobar que Zotz la detecta, la descarga, la ofrece e instala al reiniciar, sin perder datos.
  4. En modo servidor, comprobar que no instala con un agente corriendo y sí 10 min después de terminar.

## 8. Puesta en marcha

1. Implementar y mergear este spec. CI publica `v1.4.21401`, el primer release versionado.
2. **Única instalación manual:** la versión que hoy está instalada no sabe buscar en el repo de Zotz. Se descarga el instalador de `v1.4.21401` (`gh release download v1.4.21401 -R HugoRodriguezDEV/zotz -p 'zotz-windows-x64-setup.exe'`) y se instala encima. Los datos en `%APPDATA%\zotz` se conservan.
3. Borrar el release viejo `desktop-latest`.
4. Desde ahí, cada merge a `main` con código llega solo.

## 9. Archivos que se tocan

| Archivo                                                                                                           | Cambio                                                             |
| ----------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| `.github/workflows/zotz-desktop-builds.yml`                                                                       | versión, zip de macOS, manifiestos y blockmaps, release versionado |
| `config/scripts/zotz/zotz-release-version.mjs` (nuevo)                                                            | calcula la versión (§3)                                            |
| `config/electron-builder.config.cjs`                                                                              | `mac.target` + `zip`; acepta la versión de CI                      |
| `config/dev-app-update.yml`                                                                                       | repo y caché                                                       |
| `src/shared/zotz/zotz-app-identity.ts`                                                                            | `ZOTZ_RELEASE_REPO`                                                |
| `src/shared/release-channel.ts`, `updater-setup.ts`, `updater-release-readiness.ts`, `updater-prerelease-feed.ts` | repo desde la constante                                            |
| `src/shared/zotz/zotz-network-policy.ts`                                                                          | `zotz-updates`, `orca-changelog`, `orca-nudges`                    |
| `src/main/updater/zotz-updater-policy.ts`, `updater-service.ts`                                                   | encendido por setting en vez de env var                            |
| `src/main/updater/zotz-server-idle-install.ts` (nuevo)                                                            | instalar en servidor sin agentes                                   |
| `src/main/updater/lifecycle/updater-setup.ts`, `updater-state.ts`                                                 | `autoDownload` y 6 h (pocas líneas)                                |
| Ajustes → Updates (renderer)                                                                                      | switch, ocultar canales, versión con base de Orca                  |
| `docs/zotz/UPDATE.md`, `docs/zotz/PLAN.md`                                                                        | reescritura y bitácora                                             |

## 10. Riesgos

- **Sync con Orca:** puede reintroducir `stablyai/orca` en el actualizador. Lo frena el check de CI (§5.1).
- **Feed Atom:** solo lista las ~10 etiquetas más nuevas. Si se publican muchas seguidas y fallan, podría tardar en encontrar una lista. Mitigación: los releases se publican completos o no se publican (§4.5).
- **Límite de la API de GitHub** sin token: afecta solo al selector de builds, no a la revisión normal.
- **macOS** sin auto-update hasta tener firma.
