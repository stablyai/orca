import { EventEmitter } from 'node:events'
import { PostgresDatabase } from '../database.js'

export class ScriptedPoolClient extends EventEmitter {
  readonly statements: string[] = []
  release: () => void = () => undefined

  // Resolves each statement only once `gate` does, so a test can hold one mid-flight.
  constructor(private readonly gate: () => Promise<void> = async () => undefined) {
    super()
  }

  query = async (sql: string | { text: string }) => {
    this.statements.push(typeof sql === 'string' ? sql : sql.text)
    await this.gate()
    return { rows: [], rowCount: 0 }
  }
}

// Hands out the listed clients in order, reusing an object the way pg-pool reuses a connection.
export function scriptedPostgresDatabase(
  checkouts: ScriptedPoolClient[],
  connectDelayMs = 0
): PostgresDatabase {
  const pool = {
    totalCount: checkouts.length,
    idleCount: 0,
    waitingCount: 0,
    connect: async () => {
      if (connectDelayMs > 0) await new Promise((resolve) => setTimeout(resolve, connectDelayMs))
      const client = checkouts.shift()
      if (!client) throw new Error('scripted_pool_exhausted')
      // pg-pool assigns a fresh release on every checkout.
      client.release = () => undefined
      return client
    }
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: PostgresDatabase and its pool pressure read only connect, these counts and the optional options.
  return new PostgresDatabase(pool as never)
}
