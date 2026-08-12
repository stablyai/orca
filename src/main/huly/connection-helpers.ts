import type { HulyConnection } from '../../shared/types'
import { acquire, getConnection, getSecret, release } from './client'

// Why: every read/mutation resolves a connection, decrypts its secret, and
// slots into the concurrency limiter with the same try/finally. Centralizing
// here keeps callers focused on argument construction and result mapping, and
// gives `listProjects` the same empty-array fallback the rest of the surface
// uses instead of throwing on a missing connection.
export async function withConnection<T>(
  connectionId: string | null,
  fallback: T,
  fn: (connection: HulyConnection, secret: string) => Promise<T>
): Promise<T> {
  const connection = getConnection(connectionId)
  if (!connection) {
    return fallback
  }
  const secret = getSecret(connection.id)
  if (!secret) {
    return fallback
  }
  await acquire()
  try {
    return await fn(connection, secret)
  } finally {
    release()
  }
}
