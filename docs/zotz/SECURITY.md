# Seguridad del nodo Zotz

Los agentes del nodo corren con **acceso total** (Fase 4): pueden leer, borrar y ejecutar cualquier cosa a la que llegue su usuario de Windows, y con computer use ven y controlan el escritorio. La regla es simple: **acceso total ≠ acceso a todo**. Lo que no deba perderse o filtrarse no vive en esa máquina ni en ese usuario.

## 1. Usuario de Windows dedicado

Zotz corre en un usuario propio, `zotz`, separado del tuyo.

1. Desde una PowerShell de administrador (pide la contraseña sin mostrarla):

   ```powershell
   net user zotz * /add
   ```

   Déjalo como **usuario estándar**, no administrador. El asistente de Zotz pide una sola UAC cuando hace falta, y escribir la contraseña de administrador ahí es una decisión tuya, no de un agente.

2. Inicia sesión como `zotz` e instala ahí, solo para ese usuario: Zotz, los CLIs (`claude`, `codex`, `agy`) y `gh`. Tailscale se instala para toda la máquina y basta una vez.
3. Corre el asistente en modo **Servidor remoto** desde ese usuario: la tarea `\Zotz\Server` y Autologon quedan para `zotz` (ver [NODE-SETUP.md](./NODE-SETUP.md)).
4. Tu llave SSH va en `C:\Users\zotz\.ssh\authorized_keys` (usuario estándar), no en `administrators_authorized_keys`.

### Qué **no** debe haber en el usuario `zotz`

- Tu sesión personal de Chrome/Edge, gestores de contraseñas o cookies de cuentas personales. Computer use y el navegador de los agentes las usarían.
- OneDrive/Google Drive personales sincronizados: un `rm -rf` de un agente se sincroniza a la nube.
- Datos de negocios, de clientes, llaves privadas o respaldos de otras máquinas.
- Llaves SSH con acceso a servidores de producción.

> **Hoy:** en la MSI Zotz corre como `rodri`, el usuario principal. Para cumplir esta fase hay que crear `zotz` y mover ahí el nodo (pasos 1–3). Los datos de `rodri` dejan de estar al alcance de los agentes porque un usuario estándar no puede leer `C:\Users\rodri`.

## 2. Tokens con alcance mínimo y revocables

Cualquier token guardado en el usuario `zotz` hay que darlo por **expuesto a los agentes**. Por eso cada uno debe ser mínimo, con fecha de vencimiento y fácil de revocar.

| Servicio    | Qué usar                                                                                     | Alcance                                                                                                                                                                                                                               |
| ----------- | -------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| GitHub      | [Fine-grained personal access token](https://github.com/settings/personal-access-tokens/new) | _Only select repositories_: solo los repos que trabaja el nodo. Permisos: Contents y Pull requests en _Read and write_, Metadata en _Read_. Sin Administration, Secrets, Workflows ni acceso a la organización. Vencimiento: 90 días. |
| Claude Code | Cuenta o API key solo para el nodo                                                           | Si es API key: workspace propio en la consola de Anthropic con límite de gasto mensual.                                                                                                                                               |
| Codex       | Cuenta o API key solo para el nodo                                                           | Proyecto propio en OpenAI con límite de gasto.                                                                                                                                                                                        |
| Antigravity | Cuenta de Google solo para el nodo                                                           | Nunca tu cuenta personal de Google: comparte Drive y Gmail.                                                                                                                                                                           |

Para darle a `gh` el token fine-grained (y que `git` lo use):

```powershell
gh auth login --with-token   # pega el token y Enter
gh auth setup-git
```

Anota en tu gestor de contraseñas (**fuera** del nodo) qué tokens tiene la MSI y cuándo vencen.

### Si sospechas que el nodo se comprometió

1. Revoca en este orden: el token de GitHub, las API keys o sesiones de Anthropic, OpenAI y Google, y los dispositivos vinculados (**Ajustes → Servidores remotos → Compartir este equipo**, desde otro equipo si hace falta).
2. Quita la máquina de la tailnet en la consola de Tailscale (_Remove_ en el nodo).
3. Vuelve al punto de restauración (sección 3) o reinstala Windows.

## 3. Respaldo

### Punto de restauración antes de la primera puesta en marcha

Antes de correr el asistente en modo servidor, desde una PowerShell de administrador:

```powershell
Enable-ComputerRestore -Drive 'C:\'
Checkpoint-Computer -Description 'Antes de Zotz (nodo)' -RestorePointType MODIFY_SETTINGS
Get-ComputerRestorePoint | Select-Object -Last 1
```

Windows crea como máximo un punto cada 24 h. Si `Get-ComputerRestorePoint` no muestra el nuevo, es que ya había uno reciente.

Un punto de restauración regresa la configuración del sistema (energía, firewall, políticas, servicios), **no** tus archivos.

### Respaldo semanal de la carpeta de datos

La carpeta de datos de Zotz es `%APPDATA%\zotz` del usuario `zotz`. Contiene la configuración, el historial, las bases de agentes y la **identidad de pairing** (`orca-devices.json`, `orca-e2ee-keypair.json`). Quien tenga ese respaldo puede hacerse pasar por el nodo ante tus dispositivos, así que va a un disco cifrado (BitLocker To Go) o a una carpeta a la que el usuario `zotz` **no** pueda escribir.

Tarea semanal (domingo 4:00) que copia sin cachés. Créala desde una PowerShell de administrador, cambiando `D:\ZotzBackup` por tu destino:

```powershell
$src = 'C:\Users\zotz\AppData\Roaming\zotz'
$dst = 'D:\ZotzBackup'
$robocopyArgs = "`"$src`" `"$dst`" /MIR /R:1 /W:5 /XD Cache `"Code Cache`" GPUCache DawnGraphiteCache DawnWebGPUCache Crashpad logs speech-models /LOG:`"$dst.log`""
$action = New-ScheduledTaskAction -Execute 'robocopy.exe' -Argument $robocopyArgs
$trigger = New-ScheduledTaskTrigger -Weekly -DaysOfWeek Sunday -At 4am
Register-ScheduledTask -TaskPath '\Zotz\' -TaskName 'Backup' -Action $action -Trigger $trigger -User 'SYSTEM' -RunLevel Highest
```

- Corre como `SYSTEM` para que el destino pueda quedar fuera del alcance del usuario `zotz`.
- `/MIR` hace del destino un espejo, así que lo que se borra en el origen también se borra en el respaldo. Para tener historial, rota el destino (por ejemplo, un disco por semana) o usa el _Historial de archivos_ de Windows sobre `D:\ZotzBackup`.
- Las bases (`*.db` con `-wal`/`-shm`) se copian con Zotz corriendo, así que la copia puede no ser consistente. Lo crítico (configuración, dispositivos vinculados, llaves) son archivos JSON que sí se copian bien.
- Los secretos que Zotz cifra con `safeStorage` (DPAPI) solo se descifran con **el mismo usuario en la misma instalación de Windows**. Si restauras en otra máquina o tras reinstalar Windows, vuelve a iniciar sesión en los agentes y vuelve a vincular los dispositivos.

Para probarlo: `Start-ScheduledTask -TaskPath '\Zotz\' -TaskName 'Backup'` y revisa `D:\ZotzBackup.log`. Robocopy termina con código 1 cuando copió archivos; para él eso es éxito (los errores son 8 o más), aunque el Programador de tareas lo muestre como resultado `0x1`.

## 4. Lista rápida

- [ ] Usuario `zotz` estándar, nodo corriendo en ese usuario, sin datos personales ni sincronización de nube.
- [ ] Token de GitHub fine-grained, solo con los repos del nodo y vencimiento anotado.
- [ ] API keys o cuentas de agentes solo para el nodo, con límite de gasto.
- [ ] Punto de restauración creado antes del asistente.
- [ ] Tarea `\Zotz\Backup` registrada y probada una vez.
- [ ] Firewall y acceso solo por Tailscale (Fase 6, [REMOTE.md](./REMOTE.md)).
