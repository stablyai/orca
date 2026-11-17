# Zotz como nodo 24/7 (asistente de primer arranque)

La primera vez que abres Zotz (y cuando quieras desde **Ajustes → General → Esta computadora → Cambiar**) te pregunta cómo vas a usar la máquina:

- **Personal**: no toca nada del sistema. Zotz se comporta como siempre.
- **Servidor remoto**: deja la máquina lista para recibir trabajo por Tailscale, sin dormirse y arrancando sola. Todo lo que pide administrador se hace con **un solo permiso** (una UAC en Windows; el diálogo del sistema en macOS/Linux, y solo si hace falta).

Si eliges "Decidir después", el asistente vuelve a salir en el siguiente arranque. El modo se guarda en el setting `zotzMachineMode` (`unset` / `personal` / `server`). Igual que el onboarding de upstream, no aparece solo en builds de desarrollo (salvo con `ORCA_DEV_SHOW_FIRST_RUN_EDUCATION=1`) ni en lanzamientos e2e (`ORCA_E2E_USER_DATA_DIR`); desde Ajustes siempre se puede abrir.

## Qué hace el modo servidor

El asistente muestra cada paso con su estado (hecho / omitido / falló + motivo). Se puede volver a ejecutar sin duplicar nada: cada paso revisa el estado actual primero.

| Paso                        | Windows                                                                                                                                                                                                | macOS                                                                                                  | Linux                                                                                        |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------- |
| Tailscale                   | Si falta: `winget install --id Tailscale.Tailscale -e`. Pide login y espera la IP `100.x`.                                                                                                             | Si falta y hay Homebrew: `brew install --cask tailscale-app` (o `tailscale`); si no, link de descarga. | Si falta: script oficial con `pkexec`. El login es `sudo tailscale up`.                      |
| No dormirse con corriente   | `powercfg`: suspensión y hibernación nunca en AC, tapa sin acción en AC.                                                                                                                               | `pmset -c sleep 0 disksleep 0 womp 1 autorestart 1` (solo si `sleep` en AC no está ya en 0).           | Sin cambios del sistema (lo cubre "mantener despierta").                                     |
| Windows Update              | Política de horas activas (6:00–24:00, el máximo que acepta Windows son 18 h) y `NoAutoRebootWithLoggedOnUsers=1`.                                                                                     | —                                                                                                      | —                                                                                            |
| SSH                         | OpenSSH Server instalado, automático y **solo con llave** (`PasswordAuthentication no`).                                                                                                               | —                                                                                                      | —                                                                                            |
| Firewall                    | Reglas `Zotz.Server.Tailnet` (puerto de Zotz, 6768) y `Zotz.SSH.Tailnet` (22) solo desde `100.64.0.0/10`. Apaga la regla abierta de OpenSSH y quita reglas de **bloqueo** de `Zotz.exe` en ese puerto. | No hace falta.                                                                                         | Si `ufw` está activo: `ufw allow proto tcp from 100.64.0.0/10 to any port 6768`.             |
| Arranque automático         | Tarea programada `\Zotz\Server` (al iniciar sesión, en tu escritorio, se relanza cada minuto si se cae, sin límite de tiempo, con batería).                                                            | LaunchAgent `~/Library/LaunchAgents/dev.hugorodriguez.zotz.server.plist` (relanza si se cae).          | Unidad de usuario `~/.config/systemd/user/zotz-server.service` (`graphical-session.target`). |
| Mantener despierta          | Mientras Zotz corre en modo servidor, bloqueo de suspensión del sistema siempre activo (no solo con agentes trabajando). La pantalla sí puede apagarse.                                                | Igual (`caffeinate`).                                                                                  | Igual (inhibidor de systemd).                                                                |
| Aceptar conexiones remotas  | Zotz escucha fuera de loopback desde el arranque (ver abajo).                                                                                                                                          | Igual.                                                                                                 | Igual.                                                                                       |
| Enlace de acceso            | Enlace para otra computadora, enlace de navegador y QR para la app móvil, todos con la IP de Tailscale.                                                                                                | Igual.                                                                                                 | Igual.                                                                                       |
| Inicio de sesión automático | Solo instrucciones: [Sysinternals Autologon](https://learn.microsoft.com/sysinternals/downloads/autologon). Zotz nunca pide ni guarda la contraseña.                                                   | —                                                                                                      | —                                                                                            |

En Windows todo lo de administrador lo hace `zotz-node-setup.ps1`, que viene dentro del instalador (`resources\zotz\zotz-node-setup.ps1`; en el repo está en `resources/win32/zotz/`). El asistente lo lanza elevado y oculto, y deja:

- `%APPDATA%\zotz\zotz-node-setup.log`: transcripción completa del script.
- `%APPDATA%\zotz\zotz-node-setup-result.json`: resultado por paso.
- `%APPDATA%\zotz\zotz-server-task.xml`: la tarea programada que se registró.

El script también se puede correr a mano desde una PowerShell de administrador:

```powershell
powershell -NoProfile -ExecutionPolicy RemoteSigned -File "$env:LOCALAPPDATA\Programs\zotz\resources\zotz\zotz-node-setup.ps1" -Port 6768
```

(Sin `-TaskXmlPath` no registra la tarea; eso lo hace el asistente.)

### Por qué la app de escritorio y no `zotz serve` sin ventana

La tarea, el LaunchAgent y la unidad de systemd arrancan **la app de escritorio** (`Zotz.exe --zotz-node-autostart`), no el `serve` sin ventana:

1. Computer use y el navegador necesitan la sesión de escritorio del usuario. Un servicio de Windows corre en la sesión 0 y no los tiene; una tarea con token interactivo sí.
2. `Zotz.exe` es una app gráfica: no abre una consola al iniciar sesión. El lanzador de la CLI (`orca.exe`) sí abriría una.
3. Es el mismo perfil y los mismos dispositivos vinculados que usas en la ventana. El `serve` sin ventana y la app no pueden correr a la vez sobre el mismo perfil.
4. `--supervise` de `serve` todavía no existe en Windows.

Si ya hay un Zotz abierto, el relanzamiento de cada minuto sale en silencio sin traer la ventana al frente.

Para quien quiera el servidor sin ventana sigue existiendo `orca serve service install` (ahora también en Windows, ver más abajo). En Windows esa tarea se registra con `S4U`: corre en segundo plano sin abrir la consola de `orca.exe`, pero sin escritorio (sin computer use ni navegador).

### Exposición de red

Antes, la app de escritorio solo escuchaba en `0.0.0.0:6768` después de pulsar "Compartir este equipo". En modo servidor:

- **Desde el arranque**, la app escucha en todas las interfaces con la misma política de origen que `zotz serve --refuse-public`: acepta localhost, LAN y Tailscale y rechaza direcciones públicas.
- No se fija a la IP de Tailscale: esa IP cambia si el nodo se vuelve a registrar y Tailscale puede levantar después que Zotz al iniciar sesión; además, con una IP fija upstream rechaza abrir la red y el botón de vincular fallaría. En Windows el firewall deja entrar al puerto **solo** desde `100.64.0.0/10`.
- La IP de Tailscale se lee en vivo (`tailscale status --json`) cada vez que se genera un enlace.
- El paso "Aceptar conexiones remotas" abre la red en ese momento (sin reiniciar) y guarda el modo `server` **solo** si Tailscale está conectado y el paso de firewall no falló; si se cancela UAC o falla Tailscale/firewall en un equipo personal o sin configurar, no se abre la red ni se activa el modo servidor. La política de origen se aplica desde el siguiente arranque.

## Cómo deshacerlo

Elegir **Personal** en Ajustes quita el arranque automático, también si una configuración de servidor quedó a medias (en Windows puede pedir permiso de administrador porque la tarea se registró elevada). Los equipos y teléfonos ya emparejados siguen pudiendo conectarse hasta que los revoques en **Ajustes → Servidores remotos de Orca**. El resto se deshace a mano:

**Windows (PowerShell de administrador)**

```powershell
schtasks /Delete /TN "\Zotz\Server" /F
Remove-NetFirewallRule -Name Zotz.Server.Tailnet, Zotz.SSH.Tailnet
Enable-NetFirewallRule -Name OpenSSH-Server-In-TCP      # si quieres SSH desde cualquier red
Remove-ItemProperty 'HKLM:\SOFTWARE\Policies\Microsoft\Windows\WindowsUpdate' -Name SetActiveHours, ActiveHoursStart, ActiveHoursEnd
Remove-ItemProperty 'HKLM:\SOFTWARE\Policies\Microsoft\Windows\WindowsUpdate\AU' -Name NoAutoRebootWithLoggedOnUsers
powercfg /change standby-timeout-ac 30
powercfg /change hibernate-timeout-ac 0
powercfg /setacvalueindex SCHEME_CURRENT SUB_BUTTONS LIDACTION 1; powercfg /setactive SCHEME_CURRENT
# OpenSSH: Stop-Service sshd; Set-Service sshd -StartupType Manual
# (o quítalo: Remove-WindowsCapability -Online -Name OpenSSH.Server~~~~0.0.1.0)
# En %ProgramData%\ssh\sshd_config borra las dos líneas que agregó Zotz al inicio.
```

**macOS**

```sh
rm ~/Library/LaunchAgents/dev.hugorodriguez.zotz.server.plist
sudo pmset -c sleep 10 disksleep 10 autorestart 0
```

**Linux**

```sh
systemctl --user disable zotz-server.service
rm ~/.config/systemd/user/zotz-server.service && systemctl --user daemon-reload
sudo ufw delete allow proto tcp from 100.64.0.0/10 to any port 6768
```

Los enlaces de acceso se revocan en **Ajustes → Servidores remotos → Compartir este equipo**.

## Cosas que Zotz no puede hacer por ti

- **Smart App Control (Windows 11)** bloquea el instalador sin firmar de Zotz. Zotz no puede saltárselo: o lo apagas (Seguridad de Windows → Control de aplicaciones y navegador → Smart App Control; apagarlo es irreversible sin reinstalar Windows) o esperas a un instalador firmado (_Decisiones abiertas_ #3 del plan).
- **BIOS: "Restore on AC Power Loss"** (o "AC Back", "Power On after Power Fail"): actívalo en el BIOS/UEFI para que la máquina prenda sola al volver la luz. En macOS lo hace `pmset autorestart 1` cuando el equipo lo soporta.
- **Inicio de sesión automático (Windows)**: descarga [Sysinternals Autologon](https://learn.microsoft.com/sysinternals/downloads/autologon), ejecútalo con el usuario dedicado y su contraseña. La guarda cifrada como secreto LSA; Zotz nunca la ve. Sin esto, después de un corte de luz Windows se queda en la pantalla de inicio de sesión y la tarea de Zotz no arranca.
- **Llave SSH**: el servidor SSH queda solo con llave. Agrega tu llave pública en `C:\ProgramData\ssh\administrators_authorized_keys` si el usuario es administrador (y ajusta permisos con `icacls "C:\ProgramData\ssh\administrators_authorized_keys" /inheritance:r /grant "Administrators:F" /grant "SYSTEM:F"`), o en `%USERPROFILE%\.ssh\authorized_keys` si no lo es.

## `orca serve service` en Windows

`orca serve service install|status|uninstall` ahora registra la tarea `\Zotz\Serve` (mismo XML: al iniciar sesión, en tu escritorio, se relanza cada minuto, sin límite de tiempo, con batería) que corre `orca.exe serve --no-pairing …`. Solo con el perfil por defecto (una tarea no puede fijar variables de entorno). Registrar una tarea "al iniciar sesión" puede necesitar una terminal de administrador. No lo uses junto con el modo servidor del asistente: los dos sirven el mismo perfil.

## Cómo probarlo en hardware real

**Windows (la MSI)**

1. Instala el build nuevo. Ábrelo: debe salir "¿Cómo vas a usar esta computadora?" (también en una instalación existente, porque el setting nuevo empieza en `unset`).
2. Elige **Servidor remoto → Configurar servidor**. Debe salir **una sola** UAC. Revisa que cada paso termine en ✓ o con un motivo claro.
3. Comprueba: `schtasks /Query /TN "\Zotz\Server" /V /FO LIST`, `Get-NetFirewallRule -Name Zotz.*`, `powercfg /q SCHEME_CURRENT SUB_BUTTONS LIDACTION`, `Get-Service sshd`, `netstat -ano | findstr 6768` (debe escuchar en `0.0.0.0:6768` sin haber pulsado "Compartir este equipo").
4. Desde la Mac: pega el enlace del asistente en Zotz/Orca (Ajustes → Servidores remotos → Agregar) y escanea el QR con la app móvil (con el celular en Tailscale). Prueba `ssh usuario@100.x.y.z` con tu llave.
5. Cierra Zotz desde la bandeja: en menos de 1 min debe volver solo. Abre Zotz a mano mientras corre: no debe robarte el foco cada minuto.
6. Reinicia Windows (con Autologon configurado): Zotz debe arrancar solo y aceptar conexiones en menos de 2 minutos. Repite desconectando la corriente (con "Restore on AC Power Loss").
7. Ajustes → General → Cambiar → Personal: debe quitar la tarea (puede pedir UAC).
8. `orca serve service install --dry-run` / `install` / `status` / `uninstall` desde una terminal (perfil por defecto).

**macOS**: elegir Servidor remoto; si `pmset -g custom` ya tiene `sleep 0` en AC no debe pedir contraseña. Revisa el plist en `~/Library/LaunchAgents`, cierra sesión y vuelve a entrar: Zotz debe abrir solo.

**Linux**: con `ufw` activo, debe salir un diálogo de `pkexec`; `sudo ufw status` debe mostrar la regla. `systemctl --user status zotz-server.service` tras volver a iniciar sesión.
