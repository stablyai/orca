# Correctivo del criterio 8

## Cambios

- La salida confirmada del agente durante `worker-start` registra la autoridad exacta de la terminal creada antes de fallar el Dispatch.
- Tras registrar el fallo, reutiliza la liberación normal (`requestWorkerTerminalRelease` y `completeWorkerTerminalRelease`) y elimina la terminal liquidada de `residualResources`.
- La prueba directa cubre Codex y OpenCode con salida cero, y OpenCode con salida distinta de cero; exige `residualResources: []` y el cierre de `term_worker`.

## Decisiones

- La liberación automática se limita a terminales creadas por el arranque; una terminal explícita reutilizada conserva su propiedad externa.
- Si la liberación no puede confirmarse, se conserva el recibo original con su recurso residual para no declarar una liquidación falsa.
- No se modificó la detección de salida, el diagnóstico ni el formato del recibo fuera del recurso ya liberado.

## Dudas y validación

- Sin dudas funcionales pendientes.
- La batería del paquete pasó: 1.222 pruebas y 1 omitida.
- La suite global directa obtuvo 57.476 pasadas, 254 omitidas y tres fallos ambientales: dos de `node-pty-fd-leak.test.ts` por faltar el binario parcheado y uno del arnés cross-version por no disponer de tags estables.
- `pnpm test` no llegó a Vitest porque `ensure-native-runtime` no pudo cargar el `node-pty` parcheado para Node 24.3.0.
