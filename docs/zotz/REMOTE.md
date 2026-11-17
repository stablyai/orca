# Conectarse a Zotz por Tailscale

El nodo (la MSI) solo acepta conexiones de **su propia máquina** y de **tu tailnet**. No hay relay de Orca (Fase 2) ni puertos abiertos a la red local o a internet.

## 1. Requisitos

- El nodo ya pasó por el asistente en modo **Servidor remoto** (ver [NODE-SETUP.md](./NODE-SETUP.md)): Tailscale conectado, firewall y arranque automático.
- El dispositivo desde el que te conectas (laptop o celular) tiene Tailscale instalado y con sesión en **la misma tailnet**.
- Para saber la IP del nodo: en el nodo, `tailscale ip -4` (empieza con `100.`), o en la consola de Tailscale.

## 2. Vincular un dispositivo

Al terminar el asistente en el nodo (la primera vez, o al volver a correrlo desde **Ajustes → General → Esta computadora → Cambiar → Servidor remoto**) aparecen, con la IP de Tailscale leída en ese momento:

- **Enlace para otra computadora**: en la laptop, abre Zotz u Orca → **Ajustes → Servidores remotos → Agregar** y pega el enlace.
- **QR para la app móvil**: con el celular dentro de la tailnet, escanéalo desde la app oficial de Orca.
- **Enlace de navegador**: ábrelo en cualquier navegador de un dispositivo de la tailnet.

Sin pantalla en el nodo, el pairing se puede generar por SSH (paso 4) con `orca pair --address <IP-100.x>` (computadora) u `orca pair --mobile --address <IP-100.x>` (celular). La CLI empaquetada sigue llamándose `orca`. No uses `--relay`: está apagado en Zotz.

Para revocar un dispositivo: en el nodo, **Ajustes → Servidores remotos → Compartir este equipo**.

## 3. Qué acepta el nodo

| Origen                                                    | ¿Entra?                                      |
| --------------------------------------------------------- | -------------------------------------------- |
| La propia MSI (`127.0.0.1`, `::1`)                        | Sí                                           |
| Tailnet (`100.64.0.0/10`, `fd7a:115c:a1e0::/48`)          | Sí                                           |
| Red local (`192.168.x.x`, `10.x.x.x`, `172.16–31.x.x`, …) | **No**: Zotz cierra la conexión al aceptarla |
| Internet (cualquier IP pública)                           | **No**                                       |

Son dos capas:

1. **La app** (`src/main/zotz/zotz-tailnet-source-guard.ts`): en modo servidor rechaza todo lo que no sea loopback o tailnet, antes de leer HTTP o abrir el WebSocket. Las rechazadas se anotan en el log, una vez por hora.
2. **El firewall de Windows** (`zotz-node-setup.ps1`): el puerto de Zotz (6768) y el 22 solo desde `100.64.0.0/10`. Las reglas de "Permitir" que Windows crea para `Zotz.exe` la primera vez que escucha en la red se limitan también a ese rango.

No se usa `--bind <IP-de-Tailscale>`: esa IP cambia si el nodo se vuelve a registrar, Tailscale puede levantar después que Zotz al iniciar sesión, y con una IP fija upstream se niega a abrir la red y el botón de vincular falla. El filtro por origen da el mismo resultado sin esos problemas.

`orca serve` sin ventana (no lo usa el nodo) mantiene el comportamiento de upstream: para restringirlo a la tailnet usa `--bind <IP-de-Tailscale> --refuse-public` o el firewall.

## 4. SSH de respaldo

Si la app no responde, entra por SSH (solo con llave y solo desde la tailnet):

```sh
ssh <usuario>@<IP-100.x-del-nodo>
```

Agrega tu llave pública como explica [NODE-SETUP.md](./NODE-SETUP.md#cosas-que-zotz-no-puede-hacer-por-ti). Desde ahí puedes revisar la tarea (`schtasks /Query /TN "\Zotz\Server"`), relanzarla (`schtasks /Run /TN "\Zotz\Server"`) o reiniciar la máquina (`shutdown /r /t 0`).

## 5. Si no conecta

- `tailscale status` en los dos lados: ambos deben aparecer en línea.
- En el nodo, `netstat -ano | findstr 6768` debe mostrar `0.0.0.0:6768` en `LISTENING`.
- Si la laptop está en la misma red local que el nodo, conéctate igual por la IP `100.x`: la IP local (`192.168…`) se rechaza a propósito.
- Logs: `%APPDATA%\zotz\logs` (busca `Refused a connection from`).
