// Runtime switches in one Cloud Storage object per cell (cells/<cellId>.json) in the
// `<project-id>-relay-control` bucket. The bucket name comes from the metadata server, so the
// image needs no env or startup-script change.
//
// Rules: boot runs on defaults until the first good read; losing contact (404, 5xx,
// timeout, malformed body) keeps the applied values; a generation below the applied one is
// ignored; the parser voids a whole object on any bad known value.

const METADATA_ROOT = 'http://metadata.google.internal/computeMetadata/v1'
const STORAGE_ROOT = 'https://storage.googleapis.com/storage/v1'
const REQUEST_TIMEOUT_MS = 3_000
const MAX_OBJECT_BYTES = 64 * 1024
export const CONTROL_FLAG_POLL_MS = 5_000
// Refresh a cached access token this long before Google says it expires.
const ACCESS_TOKEN_EARLY_REFRESH_MS = 60_000

// `ignoredKeys` are names this image does not know: a newer writer's, or a typo.
export type ControlFlagParse<Flags> = (body: unknown) => { flags: Flags; ignoredKeys: string[] } | null

export type AppliedControlFlags<Flags> = { generation: number; flags: Flags; ignoredKeys?: string[] }

export type ControlFlagChannel<Flags> = {
  applied: () => AppliedControlFlags<Flags>
  poll: () => Promise<void>
  stop: () => void
}

type PollFailure = 'metadata' | 'not-found' | 'http' | 'network' | 'malformed' | 'void'

export function startControlFlagChannel<Flags>(input: {
  objectName: string
  defaults: Flags
  parse: ControlFlagParse<Flags>
  appliedEvent: string
  fetch?: typeof fetch
  random?: () => number
  pollMs?: number
  // Tests drive poll() directly.
  autoStart?: boolean
}): ControlFlagChannel<Flags> {
  const fetchImpl = input.fetch ?? fetch
  const random = input.random ?? Math.random
  const pollMs = input.pollMs ?? CONTROL_FLAG_POLL_MS
  let applied: AppliedControlFlags<Flags> = { generation: 0, flags: input.defaults }
  // The newest generation read, applied or voided: an unchanged void object answers 304.
  let seenGeneration = 0
  let projectId: string | null = null
  let accessToken: { value: string; refreshAt: number } | null = null
  let inFlight: Promise<void> | null = null
  let lastLoggedFailure: PollFailure | null = null
  let timer: ReturnType<typeof setTimeout> | null = null
  let stopped = false

  const metadata = async (path: string): Promise<Response> =>
    await fetchImpl(`${METADATA_ROOT}/${path}`, {
      headers: { 'Metadata-Flavor': 'Google' },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
    })

  const readProjectId = async (): Promise<string> => {
    if (projectId) return projectId
    const response = await metadata('project/project-id')
    if (!response.ok) void response.body?.cancel().catch(() => undefined)
    const value = response.ok ? (await response.text()).trim() : ''
    if (!/^[a-z][a-z0-9-]{4,62}$/.test(value)) throw new ControlFlagPollError('metadata')
    projectId = value
    return value
  }

  const readAccessToken = async (): Promise<string> => {
    if (accessToken && Date.now() < accessToken.refreshAt) return accessToken.value
    const response = await metadata('instance/service-accounts/default/token')
    if (!response.ok) {
      void response.body?.cancel().catch(() => undefined)
      throw new ControlFlagPollError('metadata')
    }
    const body: unknown = await response.json().catch(() => null)
    if (
      typeof body !== 'object' ||
      body === null ||
      !('access_token' in body) ||
      typeof body.access_token !== 'string' ||
      !('expires_in' in body) ||
      typeof body.expires_in !== 'number'
    ) {
      throw new ControlFlagPollError('metadata')
    }
    accessToken = {
      value: body.access_token,
      refreshAt: Date.now() + body.expires_in * 1_000 - ACCESS_TOKEN_EARLY_REFRESH_MS
    }
    return body.access_token
  }

  const readOnce = async (): Promise<void> => {
    const bucket = `${await readProjectId()}-relay-control`
    const url = new URL(
      `${STORAGE_ROOT}/b/${bucket}/o/${encodeURIComponent(input.objectName)}`
    )
    url.searchParams.set('alt', 'media')
    if (seenGeneration > 0) url.searchParams.set('ifGenerationNotMatch', String(seenGeneration))
    const response = await fetchImpl(url, {
      headers: { authorization: `Bearer ${await readAccessToken()}` },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
    }).catch(() => {
      throw new ControlFlagPollError('network')
    })
    if (response.status === 304) return
    // Every early exit releases the body, so an unread reply never pins its socket.
    const discard = (): void => void response.body?.cancel().catch(() => undefined)
    if (response.status === 401) accessToken = null
    if (response.status === 404) {
      discard()
      throw new ControlFlagPollError('not-found')
    }
    if (!response.ok) {
      discard()
      throw new ControlFlagPollError('http')
    }
    const generation = Number(response.headers.get('x-goog-generation'))
    if (!Number.isSafeInteger(generation) || generation <= 0) {
      discard()
      throw new ControlFlagPollError('malformed')
    }
    if (generation <= applied.generation) {
      discard()
      return
    }
    const text = await readBounded(response, MAX_OBJECT_BYTES)
    if (text === null) throw new ControlFlagPollError('malformed')
    let body: unknown
    try {
      body = JSON.parse(text)
    } catch {
      throw new ControlFlagPollError('malformed')
    }
    // Only a body read whole is "seen": a read cut off mid-body must be asked for again, or
    // every later poll would answer 304 and strand that write.
    seenGeneration = generation
    const parsed = input.parse(body)
    if (parsed === null) throw new ControlFlagPollError('void')
    const { flags, ignoredKeys } = parsed
    applied = ignoredKeys.length > 0 ? { generation, flags, ignoredKeys } : { generation, flags }
    console.log(JSON.stringify({ event: input.appliedEvent, ...applied }))
  }

  const poll = (): Promise<void> => {
    inFlight ??= readOnce()
      .then(() => {
        lastLoggedFailure = null
      })
      .catch((error: unknown) => {
        const failure = error instanceof ControlFlagPollError ? error.failure : 'network'
        // One line per change of cause, never the token or the URL's query.
        if (failure === lastLoggedFailure) return
        lastLoggedFailure = failure
        console.warn(
          JSON.stringify({
            event: 'orca_relay_control_flags_unreadable',
            object: input.objectName,
            failure,
            generation: applied.generation
          })
        )
      })
      .finally(() => {
        inFlight = null
      })
    return inFlight
  }

  const schedule = (): void => {
    if (stopped) return
    // ±20% so a fleet that booted together does not read in lockstep.
    const delay = Math.round(pollMs * (0.8 + random() * 0.4))
    timer = setTimeout(() => void poll().finally(schedule), delay)
    timer.unref?.()
  }

  if (input.autoStart !== false) void poll().finally(schedule)
  return {
    applied: () => applied,
    poll,
    stop: () => {
      stopped = true
      if (timer) clearTimeout(timer)
    }
  }
}

// Stops reading, and cancels the stream, at the first byte past the bound.
async function readBounded(response: Response, maxBytes: number): Promise<string | null> {
  if (!response.body) return ''
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    total += value.byteLength
    if (total > maxBytes) {
      await reader.cancel().catch(() => undefined)
      return null
    }
    chunks.push(value)
  }
  return Buffer.concat(chunks).toString('utf8')
}

class ControlFlagPollError extends Error {
  constructor(readonly failure: PollFailure) {
    super(failure)
  }
}
