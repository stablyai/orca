import { createHash } from 'node:crypto'
import { metadataAccessToken } from './google-metadata.js'

const LEASE_TTL_MS = 35 * 60 * 1_000

type LeaseRecord = {
  operationId: string
  requestDigest: string
  imageCommit: string
  acquiredAt: number
  expiresAt: number
}

type ObjectMetadata = {
  generation: string
}

export class MutationLeaseConflict extends Error {}

export type MutationLease = {
  generation: string
  record: LeaseRecord
}

export type ExpectedMutationLease = {
  generation: string
  operationId: string
  requestDigest: string
}

export class GoogleStorageMutationLease {
  constructor(
    private readonly bucket: string,
    private readonly objectName: string,
    private readonly imageCommit: string,
    private readonly fetcher: typeof fetch = fetch,
    private readonly now: () => number = Date.now
  ) {}

  async acquire(
    operationId: string,
    request: unknown,
    expectedExisting?: ExpectedMutationLease
  ): Promise<MutationLease> {
    const token = await metadataAccessToken(this.fetcher)
    const existing = await this.read(token)
    const requestDigest = createHash('sha256')
      .update(JSON.stringify(request))
      .digest('hex')
    const exactTakeover =
      existing &&
      expectedExisting?.generation === existing.metadata.generation &&
      expectedExisting.operationId === existing.record.operationId &&
      expectedExisting.requestDigest === existing.record.requestDigest
    if (
      (!existing && expectedExisting) ||
      (existing &&
        existing.record.requestDigest !== requestDigest &&
        existing.record.expiresAt > this.now() &&
        !exactTakeover)
    ) {
      throw new MutationLeaseConflict('another relay mutation owns the durable lease')
    }
    const acquiredAt = this.now()
    const record: LeaseRecord = {
      operationId,
      requestDigest,
      imageCommit: this.imageCommit,
      acquiredAt,
      expiresAt: acquiredAt + LEASE_TTL_MS
    }
    const generation = existing?.metadata.generation ?? '0'
    const response = await this.fetcher(
      `${this.uploadUrl()}&ifGenerationMatch=${encodeURIComponent(generation)}`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(record)
      }
    )
    if (response.status === 412) {
      throw new MutationLeaseConflict('relay mutation lease changed concurrently')
    }
    if (!response.ok) throw new Error(`mutation lease acquisition failed: ${response.status}`)
    const metadata = (await response.json()) as Partial<ObjectMetadata>
    if (!/^[1-9][0-9]{0,30}$/.test(metadata.generation ?? '')) {
      throw new Error('mutation lease has no valid generation')
    }
    return { generation: metadata.generation!, record }
  }

  async release(lease: MutationLease): Promise<void> {
    const token = await metadataAccessToken(this.fetcher)
    const response = await this.fetcher(
      `${this.metadataUrl()}?ifGenerationMatch=${encodeURIComponent(lease.generation)}`,
      {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${token}` }
      }
    )
    if (!response.ok && response.status !== 404) {
      throw new Error(`mutation lease release failed: ${response.status}`)
    }
  }

  private async read(
    token: string
  ): Promise<{ metadata: ObjectMetadata; record: LeaseRecord } | null> {
    const metadataResponse = await this.fetcher(this.metadataUrl(), {
      headers: { Authorization: `Bearer ${token}` }
    })
    if (metadataResponse.status === 404) return null
    if (!metadataResponse.ok) {
      throw new Error(`mutation lease inspection failed: ${metadataResponse.status}`)
    }
    const metadata = (await metadataResponse.json()) as Partial<ObjectMetadata>
    if (!/^[1-9][0-9]{0,30}$/.test(metadata.generation ?? '')) {
      throw new Error('existing mutation lease has no valid generation')
    }
    const bodyResponse = await this.fetcher(`${this.metadataUrl()}?alt=media`, {
      headers: { Authorization: `Bearer ${token}` }
    })
    if (!bodyResponse.ok) {
      throw new Error(`mutation lease body read failed: ${bodyResponse.status}`)
    }
    const record = (await bodyResponse.json()) as Partial<LeaseRecord>
    if (
      typeof record.operationId !== 'string' ||
      !/^[a-f0-9]{64}$/.test(record.requestDigest ?? '') ||
      !/^[a-f0-9]{40}$/.test(record.imageCommit ?? '') ||
      !Number.isSafeInteger(record.acquiredAt) ||
      !Number.isSafeInteger(record.expiresAt)
    ) {
      throw new Error('existing mutation lease is invalid')
    }
    return {
      metadata: { generation: metadata.generation! },
      record: record as LeaseRecord
    }
  }

  private metadataUrl(): string {
    return `https://storage.googleapis.com/storage/v1/b/${encodeURIComponent(this.bucket)}/o/${encodeURIComponent(this.objectName)}`
  }

  private uploadUrl(): string {
    return `https://storage.googleapis.com/upload/storage/v1/b/${encodeURIComponent(this.bucket)}/o?uploadType=media&name=${encodeURIComponent(this.objectName)}`
  }
}
