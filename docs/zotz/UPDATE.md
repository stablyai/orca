# Actualizar Zotz

Zotz se actualiza **desde sus propios releases** (`HugoRodriguezDEV/zotz`), nunca desde los de Orca. El diseño completo está en [UPDATES-SPEC.md](./UPDATES-SPEC.md).

## Cómo llega una versión nueva

1. Cada merge a `main` que cambie código publica un release `v1.4.<parche×100 + build>`. Por ejemplo, `v1.4.21427` = Orca 1.4.214, build 27 de Zotz. Los cambios solo de docs no publican.
2. Zotz revisa al arrancar y cada 6 horas. En Windows y en el AppImage de Linux la **descarga sola** en segundo plano.
3. Muestra "Hay una versión nueva" en Ajustes → Acerca de y en la barra de estado.
4. **Nunca reinicia sola:**
   - **Personal:** se instala cuando le das "Reiniciar para actualizar" o cuando cierras Zotz.
   - **Modo servidor:** se instala sola después de 10 minutos seguidos sin agentes trabajando, y la tarea `\Zotz\Server` vuelve a levantar Zotz. Con un agente trabajando, espera.

Para apagarlo: Ajustes → Acerca de → "Buscar y descargar versiones nuevas de Zotz". Se aplica al reiniciar. Para launches automatizados que nunca deben tocar GitHub existe `ZOTZ_DISABLE_UPDATER=1`.

| Plataforma     | Qué pasa                                                                                                                   |
| -------------- | -------------------------------------------------------------------------------------------------------------------------- |
| Windows        | Descarga e instala (sin firma funciona; SmartScreen solo pregunta en instalaciones manuales).                              |
| Linux AppImage | Descarga e instala.                                                                                                        |
| Linux deb      | Avisa; se instala con el gestor de paquetes.                                                                               |
| macOS          | Descarga e instala si el Zotz instalado está firmado con el certificado de Zotz; si es ad-hoc, avisa con enlace al `.dmg`. |

Lo de Orca que sigue apagado:

- Las novedades y campañas de `orca.dev` (política de red `orca-whats-new`).
- Los canales RC, hourly, daily y adhoc: el selector oculto de canales ya no existe.

## Firma de macOS (una vez)

Zotz firma sus builds de macOS con un certificado propio y gratuito (`Zotz Release Signing`). Apple no lo conoce, así que la primera instalación sigue pidiendo `xattr -dr com.apple.quarantine /Applications/Zotz.app`. Pero la identidad es la misma en todos los releases, y por eso los updates se instalan solos.

1. En tu Mac: `bash config/scripts/release/zotz-create-mac-signing-cert.sh`. Crea `~/zotz-mac-signing/` y no sube nada.
2. Guarda el `.p12` y `password.txt` en tu gestor de contraseñas.
3. Sube los dos secrets con los comandos que imprime el script (`ZOTZ_MAC_CERT_P12` y `ZOTZ_MAC_CERT_PASSWORD`) y borra la carpeta.

Sin esos secrets, CI publica el build de macOS con firma ad-hoc (avisa en el run) y esas instalaciones solo se actualizan a mano. El primer build firmado se instala a mano una vez; desde ahí se actualiza solo.

## La primera vez (una sola instalación manual)

Las versiones anteriores a la Fase 3b no saben buscar en el repo de Zotz. Descarga la primera versión con updates e instálala encima; los datos en `%APPDATA%\zotz` se conservan:

```powershell
gh release download v1.4.21401 -R HugoRodriguezDEV/zotz -p zotz-windows-x64-setup.exe
.\zotz-windows-x64-setup.exe
```

Desde ahí, las siguientes llegan solas.

## Construir desde el código (opcional)

Para probar un cambio sin pasar por un release, en PowerShell dentro del clon:

```powershell
git switch main
git pull --ff-only
corepack pnpm install
corepack pnpm build:win
```

- `build:win` deja el instalador NSIS en `dist\`. Una build local conserva la versión de Orca (`1.4.214`), así que el actualizador le ofrecerá el siguiente release de Zotz.
- `corepack pnpm build:unpack` deja la app desempaquetada en `dist\win-unpacked\` para probar sin instalar.
- Construir en Windows necesita Visual Studio con "Desktop development with C++" (módulos nativos).

## Cómo se publica (CI)

`.github/workflows/zotz-desktop-builds.yml`:

1. Revisa que el actualizador no apunte a `stablyai/orca` (`zotz-check-release-repo-refs.mjs`).
2. Calcula la versión (`zotz-release-version.mjs`).
3. Construye Windows, macOS (dmg + zip) y Linux con esa versión.
4. Sube los manifiestos `latest*.yml`, los archivos que nombran y sus `.blockmap` con su nombre original, más copias `zotz-*` para descargar a mano (`zotz-stage-release-assets.mjs`).
5. Crea el release estable `v<versión>` marcado como _latest_.

Si una plataforma falla (pasa con los runners macOS arm64 de GitHub), el release sale con las demás y esas máquinas simplemente no ven esa versión.
