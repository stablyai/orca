export function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Expected integration object')
  }
  return Object.fromEntries(Object.entries(value))
}
export function text(value: unknown): string {
  if (typeof value !== 'string') {
    throw new Error('Expected integration string')
  }
  return value
}
export function integer(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) {
    throw new Error('Expected integration integer')
  }
  return value
}
export function strings(value: unknown): string[] {
  if (!Array.isArray(value)) {
    throw new Error('Expected integration list')
  }
  return value.map(text)
}
export function headers(value: unknown): Record<string, string> {
  return Object.fromEntries(Object.entries(record(value)).map(([key, value]) => [key, text(value)]))
}
export type Command = { id: string; op: string; data: Record<string, unknown> }
export function command(value: unknown): Command {
  const row = record(value)
  return { id: text(row.id), op: text(row.op), data: record(row.data) }
}
export async function post(base: string, path: string, body: unknown): Promise<unknown> {
  const response = await fetch(base + path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body)
  })
  if (!response.ok) {
    throw new Error(`Integration bridge ${path}: ${response.status} ${await response.text()}`)
  }
  return response.json()
}
export function httpResult(value: unknown): Response {
  const row = record(value)
  const body = text(row.body)
  return new Response(body || null, { status: integer(row.status), headers: headers(row.headers) })
}
export async function companion(
  role: 'mobile' | 'cloud',
  dispatch: (op: string, data: Record<string, unknown>) => Promise<unknown>
): Promise<void> {
  const base = text(process.env.ORCA_PUSH_OWNER_BRIDGE)
  await post(base, '/ready', { role })
  for (;;) {
    const response = await fetch(`${base}/next?role=${role}`)
    if (!response.ok) {
      throw new Error('Integration command transport closed')
    }
    const next = command(await response.json())
    try {
      const result = next.op === 'stop' ? null : await dispatch(next.op, next.data)
      await post(base, '/result', { id: next.id, role, ok: true, data: result ?? null })
    } catch (error) {
      await post(base, '/result', { id: next.id, role, ok: false, data: String(error) })
      throw error
    }
    if (next.op === 'stop') {
      return
    }
  }
}

export function ownerCleanup(primary?: { failed: true; error: unknown }) {
  const failures: unknown[] = primary ? [primary.error] : []
  return {
    get failed() {
      return failures.length > 0
    },
    async run(operation: () => unknown): Promise<void> {
      try {
        await operation()
      } catch (error) {
        failures.push(error)
      }
    },
    finish(): void {
      if (failures.length === 1) {
        throw failures[0]
      }
      if (failures.length > 1) {
        throw new AggregateError(
          failures,
          'Live owner iteration or cleanup failed',
          primary ? { cause: primary.error } : undefined
        )
      }
    }
  }
}
