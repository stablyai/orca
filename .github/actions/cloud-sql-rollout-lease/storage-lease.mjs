// Compare-and-swap lease over a single Cloud Storage object.
//
// Ported from apps/relay-fence-broker/src/mutation-lease.ts rather than imported: this action is
// duplicated verbatim into stablyai/orca, so it must carry no repo-local imports. Only the
// algorithm is shared (read metadata -> write with ifGenerationMatch -> 412 is a conflict ->
// generation-matched delete -> an expired record is free). The broker's token path is NOT shared;
// it reads the GCE metadata server, which does not exist on Actions runners.

export const LEASE_TTL_MS = 35 * 60 * 1_000
export const RENEW_INTERVAL_MS = 5 * 60 * 1_000

const GENERATION = /^[1-9][0-9]{0,30}$/

export class LeaseConflict extends Error {
  constructor(message, holder) {
    super(message)
    this.name = 'LeaseConflict'
    this.holder = holder ?? null
  }
}

/** A live record we cannot parse is never treated as free; wedging beats double-rollout. */
export class LeaseUnreadable extends Error {
  constructor(message) {
    super(message)
    this.name = 'LeaseUnreadable'
  }
}

function parseRecord(raw) {
  if (!raw || typeof raw !== 'object') {
    return null
  }
  if (typeof raw.holder_key !== 'string' || raw.holder_key.length === 0) {
    return null
  }
  if (!Number.isSafeInteger(raw.acquired_at) || !Number.isSafeInteger(raw.expires_at)) {
    return null
  }
  return {
    repository: typeof raw.repository === 'string' ? raw.repository : 'unknown',
    workflow: typeof raw.workflow === 'string' ? raw.workflow : 'unknown',
    run_id: typeof raw.run_id === 'string' ? raw.run_id : 'unknown',
    run_url: typeof raw.run_url === 'string' ? raw.run_url : 'unknown',
    run_attempt: typeof raw.run_attempt === 'string' ? raw.run_attempt : 'unknown',
    acquired_at: raw.acquired_at,
    expires_at: raw.expires_at,
    holder_key: raw.holder_key
  }
}

function describe(record) {
  return `${record.repository} / ${record.workflow} (run ${record.run_id}, attempt ${record.run_attempt}) ${record.run_url}`
}

export class CloudSqlRolloutLease {
  #bucket
  #objectName
  #accessToken
  #fetcher
  #now
  #warn

  constructor({
    bucket,
    objectName,
    accessToken,
    fetcher = fetch,
    now = Date.now,
    warn = (message) => console.log(`::warning::${message}`)
  }) {
    this.#bucket = bucket
    this.#objectName = objectName
    this.#accessToken = accessToken
    this.#fetcher = fetcher
    this.#now = now
    this.#warn = warn
  }

  get uri() {
    return `gs://${this.#bucket}/${this.#objectName}`
  }

  async acquire(holder) {
    const existing = await this.read()
    const now = this.#now()
    if (!existing) {
      return this.#claim(holder, '0', now, now, 'created')
    }
    if (existing.record.holder_key === holder.holderKey) {
      // Same run, another job in the wave chain. Refresh, never fail.
      return this.#claim(
        holder,
        existing.generation,
        existing.record.acquired_at,
        now,
        'reentrant',
        existing.record
      )
    }
    if (existing.record.expires_at > now) {
      throw new LeaseConflict(
        `${this.uri} is held by ${describe(existing.record)} until ${new Date(existing.record.expires_at).toISOString()}`,
        existing.record
      )
    }
    this.#warn(
      `Taking over an expired Cloud SQL rollout lease on ${this.uri}. Stale holder: ${describe(existing.record)}, expired ${new Date(existing.record.expires_at).toISOString()}.`
    )
    return this.#claim(holder, existing.generation, now, now, 'takeover', existing.record)
  }

  async renew(holderKey) {
    const existing = await this.read()
    if (!existing) {
      return { renewed: false, reason: 'absent' }
    }
    if (existing.record.holder_key !== holderKey) {
      return { renewed: false, reason: 'foreign' }
    }
    const now = this.#now()
    const record = { ...existing.record, expires_at: now + LEASE_TTL_MS }
    const written = await this.#write(record, existing.generation)
    return { renewed: true, generation: written.generation, record }
  }

  async release(holderKey) {
    const existing = await this.read()
    if (!existing) {
      return { released: false, reason: 'absent' }
    }
    if (existing.record.holder_key !== holderKey) {
      return { released: false, reason: 'foreign', holder: existing.record }
    }
    const response = await this.#fetcher(
      `${this.#metadataUrl()}?ifGenerationMatch=${encodeURIComponent(existing.generation)}`,
      { method: 'DELETE', headers: { Authorization: `Bearer ${await this.#token()}` } }
    )
    if (response.status === 412) {
      return { released: false, reason: 'conflict' }
    }
    if (!response.ok && response.status !== 404) {
      throw new Error(`lease release failed: ${response.status}`)
    }
    return { released: true, generation: existing.generation }
  }

  async read() {
    const token = await this.#token()
    const metadataResponse = await this.#fetcher(this.#metadataUrl(), {
      headers: { Authorization: `Bearer ${token}` }
    })
    if (metadataResponse.status === 404) {
      return null
    }
    if (!metadataResponse.ok) {
      throw new Error(`lease inspection failed: ${metadataResponse.status}`)
    }
    const metadata = await metadataResponse.json()
    if (!GENERATION.test(metadata?.generation ?? '')) {
      throw new LeaseUnreadable(`${this.uri} has no valid generation`)
    }
    const bodyResponse = await this.#fetcher(`${this.#metadataUrl()}?alt=media`, {
      headers: { Authorization: `Bearer ${token}` }
    })
    if (bodyResponse.status === 404) {
      return null
    }
    if (!bodyResponse.ok) {
      throw new Error(`lease body read failed: ${bodyResponse.status}`)
    }
    let raw = null
    try {
      raw = await bodyResponse.json()
    } catch {
      raw = null
    }
    const record = parseRecord(raw)
    if (!record) {
      throw new LeaseUnreadable(
        `${this.uri} holds an unreadable lease record; an operator must inspect and delete it before rollouts can resume`
      )
    }
    return { generation: metadata.generation, record }
  }

  async #claim(holder, generation, acquiredAt, now, state, previous) {
    const record = {
      repository: holder.repository,
      workflow: holder.workflow,
      run_id: holder.runId,
      run_url: holder.runUrl,
      run_attempt: holder.runAttempt,
      acquired_at: acquiredAt,
      expires_at: now + LEASE_TTL_MS,
      holder_key: holder.holderKey
    }
    const written = await this.#write(record, generation)
    return { state, generation: written.generation, record, previous: previous ?? null }
  }

  async #write(record, generation) {
    const response = await this.#fetcher(
      `${this.#uploadUrl()}&ifGenerationMatch=${encodeURIComponent(generation)}`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${await this.#token()}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(record)
      }
    )
    if (response.status === 412) {
      throw new LeaseConflict(`${this.uri} changed concurrently while we were claiming it`)
    }
    if (!response.ok) {
      throw new Error(`lease write failed: ${response.status}`)
    }
    const metadata = await response.json()
    if (!GENERATION.test(metadata?.generation ?? '')) {
      throw new LeaseUnreadable(`${this.uri} write returned no valid generation`)
    }
    return { generation: metadata.generation }
  }

  async #token() {
    return typeof this.#accessToken === 'function' ? await this.#accessToken() : this.#accessToken
  }

  #metadataUrl() {
    return `https://storage.googleapis.com/storage/v1/b/${encodeURIComponent(this.#bucket)}/o/${encodeURIComponent(this.#objectName)}`
  }

  #uploadUrl() {
    return `https://storage.googleapis.com/upload/storage/v1/b/${encodeURIComponent(this.#bucket)}/o?uploadType=media&name=${encodeURIComponent(this.#objectName)}`
  }
}

export const describeHolder = describe
