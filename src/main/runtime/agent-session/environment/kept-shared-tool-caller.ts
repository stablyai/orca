// A kept chat run's shared-tool caller: as its file holds it (sealed whole but for the session id,
// run fence and owner), and as this run holds it once the keychain opened it.
import { jsonObject } from '../../../../shared/json-stream/json-value-property'
import { unsealRelaySecret } from '../../../bots/tool-relay/relay-sealed-file'

export type StoredSharedToolCaller = {
  sessionId: string
  runFence: number
  owner: string
  sealed: string
}

/** A kept caller as this run holds it. */
export type KeptSharedToolCaller = {
  sessionId: string
  runFence: number
  owner: string
  caller: Readonly<Record<string, string>>
  token: string
}

export function isStoredCaller(value: unknown): value is StoredSharedToolCaller {
  const entry = jsonObject(value)
  return (
    entry !== null &&
    typeof entry.sessionId === 'string' &&
    typeof entry.runFence === 'number' &&
    Number.isSafeInteger(entry.runFence) &&
    typeof entry.owner === 'string' &&
    typeof entry.sealed === 'string'
  )
}

export const callerKey = (entry: StoredSharedToolCaller): string =>
  `${entry.sessionId}\n${entry.runFence}`

export async function opened(entry: StoredSharedToolCaller): Promise<KeptSharedToolCaller | null> {
  try {
    const payload = jsonObject(JSON.parse(await unsealRelaySecret(entry.sealed)))
    const token = payload?.token
    const caller: Record<string, string> = {}
    for (const [name, value] of Object.entries(jsonObject(payload?.caller) ?? {})) {
      if (typeof value !== 'string') {
        return null
      }
      caller[name] = value
    }
    if (typeof token !== 'string' || !jsonObject(payload?.caller)) {
      return null
    }
    return {
      sessionId: entry.sessionId,
      runFence: entry.runFence,
      owner: entry.owner,
      caller,
      token
    }
  } catch {
    return null
  }
}
