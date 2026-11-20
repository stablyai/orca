# Spec — Cola de memoria de los servidores y archivar conversaciones principales

Dos arreglos que salieron de usar Zotz con la MSI como servidor. Rama: `zotz/servidores-cola-y-archivar`. Reglas del fork: [`PLAN.md`](./PLAN.md) (diff mínimo contra upstream, lógica nueva en archivos `zotz-*`, no renombrar RPC ni `ORCA_*`).

## 1. Problemas

**A. No se puede archivar ni eliminar la conversación principal de un proyecto.**
En `MSI Server` el proyecto `uni` solo tiene su carpeta como conversación (`isMainWorktree: true`). `ZotzConversationMenu` ofrece _Archive_ y _Delete_ solo si `!worktree.isMainWorktree`, así que para esa fila no existen. Además:

- `ZotzArchivedSection` filtra `worktree.isArchived && !worktree.isMainWorktree`: una principal archivada no aparecería en _Archivadas_ y no habría forma de restaurarla.
- `archiveZotzConversation` lanza `updateWorktreeMeta` con `void`, ignora el resultado y muestra "Conversation archived" aunque falle (en un servidor remoto o sin conexión).

**B. La laptop no ve la cola de memoria de los servidores.**
El limitador (#24) vive en el proceso principal de cada Zotz y publica por IPC solo a las ventanas de esa máquina (`zotz-agent-queue-ipc.ts`). Cuando la MSI retiene el arranque de un agente por poca memoria, su propia ventana muestra `Queued · next to start`, pero en la laptop la conversación solo dice `Working…`: sin marca de espera, sin tablero y sin poder cancelar ni pulsar _Launch anyway_.

## 2. Parte A — Archivar conversaciones principales

**Regla nueva:** _Archive_ se ofrece también en conversaciones principales. _Delete_ sigue bloqueado para ellas (borrar el checkout del proyecto no es lo que se quiere; para quitar el proyecto está _Quitar proyecto_).

Cambios:

1. `ZotzConversationMenu.tsx`: sacar _Archive_ del `if (!isMainWorktree)`; _Delete_ se queda dentro.
2. `ZotzArchivedSection.tsx`: listar archivadas incluyendo principales (quitar `&& !worktree.isMainWorktree`).
3. `zotz-archive.ts`: `setZotzConversationArchived` pasa `executionHostId: worktree.hostId` y devuelve el resultado; `archiveZotzConversation` solo muestra el aviso de éxito si `ok`; si falla, `toast.error` con el motivo y sin "Deshacer".
4. `ZotzConversationRow.tsx` (`useArchiveOnMerge`): se queda como está; una principal **nunca** se archiva sola al hacer merge.
5. Una conversación principal archivada vuelve a aparecer solo al restaurarla; no se des-archiva sola cuando arranca un agente en ella.

Verificación: fixture `ZotzProjectSidebar` con una principal activa y una archivada; una prueba de la lista de archivadas que incluya principales (el valor esperado fijo, sin importar la lógica de producción).

## 3. Parte B — Cola de memoria por servidor

### 3.1 Servidor (cualquier Zotz con la cola activa)

Llamadas nuevas, solo se agregan (no se renombra nada existente):

| Método                            | Tipo      | Permiso     | Hace                                           |
| --------------------------------- | --------- | ----------- | ---------------------------------------------- |
| `zotz.agentQueue.snapshot`        | método    | `workspace` | devuelve `ZotzAgentQueueSnapshot`              |
| `zotz.agentQueue.subscribe`       | streaming | `workspace` | emite el snapshot al conectar y en cada cambio |
| `zotz.agentQueue.cancel`          | método    | `workspace` | cancela un arranque en cola por `id`           |
| `zotz.agentQueue.forceStart`      | método    | `workspace` | _Launch anyway_                                |
| `zotz.agentQueue.dismissCanceled` | método    | `workspace` | quita la marca de cancelado                    |

- Contrato de parámetros (zod): `src/shared/rpc-contract/zotz/zotz-agent-queue-params.ts`. Los `id` se validan igual que en el IPC (cadena, 1 a 1024 caracteres).
- Métodos: `src/main/runtime/rpc/methods/zotz/zotz-agent-queue.ts`, registrados en `rpc-method-registry.ts`. Delegan en `getZotzMemoryGovernor()` / `getZotzAgentLaunchQueue()` y reutilizan `buildZotzAgentQueueSnapshot`; no duplican lógica.
- Capability `zotz.agent-queue.v1` publicada en `shared/protocol-version.ts` para que el cliente detecte soporte sin llamar a un método que fallaría.
- Si el limitador no está iniciado (por ejemplo `serve` sin escritorio), `snapshot` devuelve el vacío y `cancel`/`forceStart` no hacen nada.

### 3.2 Cliente (laptop)

- `src/renderer/src/components/zotz/agent-queue/zotz-host-agent-queue-store.ts`: mapa `hostId → ZotzAgentQueueSnapshot`. Se suscribe a cada servidor emparejado y conectado que declare la capability; se re-suscribe con `subscribeRuntimeHostContactRegained`; olvida el servidor cuando se desconecta o se quita.
- `useZotzAgentQueue(hostId?)`: sin argumento devuelve la cola local (comportamiento actual); con un `hostId` remoto, la de ese servidor.
- Acciones `cancel` / `forceStart` / `dismissCanceled` enrutan a IPC (local) o a la llamada RPC (remoto) según el host de la conversación.
- Las claves por conversación pasan a ser `hostId + label`, porque dos servidores pueden tener conversaciones con el mismo nombre.

### 3.3 Interfaz

- `ZotzQueuedPanePortals` y `ZotzQueuedChatNotice`: eligen la cola por `worktree.hostId`. El aviso de la conversación remota sustituye al `Working…` engañoso y sus botones actúan en el servidor.
- `ZotzConversationRow`: la marca de reloj de arena y `Queued · N min` usan la cola del host de la fila.
- `ZotzAgentQueueBoard`: una sección por máquina (`Esta Mac`, `MSI Server`) con su memoria (total, libre, presión), agentes en ejecución y cola.
- `ZotzAgentQueueStatusSegment`: muestra la cola local y suma las esperas de servidores con un indicador por servidor.

### 3.4 Compatibilidad

- Servidor viejo sin la capability: la laptop no muestra su cola y no hay errores ni reintentos.
- Cliente viejo con servidor nuevo: ignora las llamadas nuevas; sigue funcionando.
- La ventana local de la MSI sigue usando IPC sin cambios.
- Para ver la cola de la MSI en la laptop, la MSI debe tener el release nuevo.

### 3.5 Seguridad

- Las cinco llamadas exigen acceso emparejado con permiso `workspace`, el mismo que permite crear terminales. _Launch anyway_ fuerza arrancar con poca memoria; no se expone a clientes sin ese permiso.
- No se envían rutas, comandos ni contenido de terminales: solo agente, etiqueta del workspace y números de memoria, igual que hoy en la ventana local.

## 4. Fases y PRs

1. **PR 1 (#26, mergeado):** este spec + Parte A (archivar principales).
2. **PR 2 (lectura):** RPC `snapshot`/`subscribe` y capability, store por servidor, aviso de cola en el chat de un servidor (solo lectura, con "En MSI Server") y reloj de arena en la barra lateral. **Pendiente para después:** las tarjetas sobre terminales de un servidor (hay que comprobar que la clave de panel coincide entre la laptop y el servidor) y el tablero con una sección por máquina.
3. **PR 3 (acciones):** `zotz.agentQueue.cancel`, `forceStart` y `dismissCanceled` en el servidor, con la capability `zotz.agent-queue-control.v1`, y los botones del aviso del chat de un servidor (cancelar y _Launch anyway_). Los botones solo salen si el servidor declara esa capability; si no, el aviso queda de solo lectura.

Cada PR pasa `pnpm check:changed`, sale a `main` y, para macOS, el release se arma según el procedimiento de firma local (el runner `macos-15` de GitHub suele no estar disponible).

## 5. Verificación

- Fixtures con `pnpm fixtures:shot`: principal archivable y archivada; chat con aviso de cola de un servidor; tablero con dos máquinas.
- Pruebas solo donde fallen al revertir el cambio: ids inválidos rechazados por la RPC; el store de host olvida un servidor desconectado y se re-suscribe al recuperar contacto; la lista de archivadas incluye principales.
- Manual con la MSI: bajar el libre mínimo en la MSI hasta que encole, comprobar que la laptop ve la marca, la cola y el tablero; cancelar y _Launch anyway_ desde la laptop; repetirlo con la MSI en el release viejo (no debe romper nada).

## 6. Decisiones y preguntas abiertas

**Decidido (Hugo, 2026-11-20):** los límites de memoria de cada servidor salen solo de su RAM, como ya quedó en #24 (solo decide la RAM; sin tope por cantidad de agentes). Este spec no los cambia: cada máquina calcula los suyos y la laptop solo los muestra.

Abiertas:

1. ¿Una principal archivada debe des-archivarse sola cuando se arranca un agente en ella? Propuesta: no.
2. ¿`zotzAgentQueueEnabled` de un servidor se puede cambiar desde la laptop? Fuera de este spec; por ahora cada máquina lo decide en sus propios ajustes.
3. El chip de dispositivo usa el nombre del servidor tal como se guardó (`MSI Server`). Cambiarlo es un ajuste de Remote Zotz Servers, no un cambio de código.

## 7. Fuera de alcance

- Eliminar la conversación principal (sigue bloqueado).
- Cambiar los límites de memoria por defecto.
- Cola para servidores SSH sin Zotz.
