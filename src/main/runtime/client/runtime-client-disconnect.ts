export function isClientDisconnectedError(error: unknown): boolean {
  return error instanceof Error && error.message === 'client_disconnected'
}
