/** Keep answer timestamps in a leaf module to break the serving gate/connection-cache import cycle. */
export type SharedControlSocket = {
  isReady(): boolean
  readonly socketGeneration: { peek(): number }
  request(method: string, params: unknown, timeoutMs: number): Promise<unknown>
}

/** A ready control socket; `socket` changes whenever it reconnects or the connection is replaced. */
export type ReadySharedControlSocket = {
  environmentId: string
  socket: string
  request: SharedControlSocket['request']
}

const sources = new Map<
  string,
  { connection: SharedControlSocket; answeredAt: () => number | null; instance: number }
>()
// Connection replacements restart socket generations; include instance identity in the key.
let nextInstance = 0

export function setSharedControlAnswerSource(
  environmentId: string,
  connection: SharedControlSocket,
  answeredAt: () => number | null
): void {
  sources.set(environmentId, { connection, answeredAt, instance: ++nextInstance })
}

export function clearSharedControlAnswerSource(environmentId: string): void {
  sources.delete(environmentId)
}

/** Null while there is no ready control socket for the environment. */
export function getRemoteRuntimeSharedControlAnsweredAt(environmentId: string): number | null {
  return sources.get(environmentId)?.answeredAt() ?? null
}

/** Every ready control socket, without opening one. */
export function listReadySharedControlSockets(): ReadySharedControlSocket[] {
  return [...sources.entries()].flatMap(([environmentId, { connection, instance }]) =>
    connection.isReady()
      ? [
          {
            environmentId,
            socket: `${instance}:${connection.socketGeneration.peek()}`,
            request: (method: string, params: unknown, timeoutMs: number) =>
              connection.request(method, params, timeoutMs)
          }
        ]
      : []
  )
}
