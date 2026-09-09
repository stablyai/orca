import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import {
  describeResourceReservationConflict,
  TerminalReservationBindingSchema,
  resourceReservationBindingMatchesRequest,
  type ResourceReservationBinding,
  type ResourceReservationRequest
} from '../../shared/resource-reservation-binding'
import { z } from 'zod'

const TERMINAL_RESERVATIONS_FILE = 'terminal-reservations.json'
const TerminalReservationEntrySchema = z.object({
  handle: z.string().min(1).max(256),
  binding: TerminalReservationBindingSchema
})

export type TerminalReservationBindResult =
  | { outcome: 'bound' }
  | { outcome: 'replay'; binding: ResourceReservationBinding }
  | { outcome: 'conflict'; message: string }

/** Durable reservation authority. Claims are persisted before provider mutation. */
export class TerminalReservationBindings {
  private readonly byHandle = new Map<string, ResourceReservationBinding>()
  private readonly handleByKey = new Map<string, string>()
  private storagePath: string | null = null

  constructor(profileStorageDirectory?: string) {
    if (profileStorageDirectory) {
      this.configurePersistence(profileStorageDirectory)
    }
  }

  configurePersistence(profileStorageDirectory: string): void {
    const storagePath = join(profileStorageDirectory, TERMINAL_RESERVATIONS_FILE)
    const [byHandle, handleByKey] = this.hydrate(storagePath)
    this.storagePath = storagePath
    this.replaceState(byHandle, handleByKey)
  }

  /** Atomically claims a key before creation, or returns its immutable prior binding. */
  claim(handle: string, binding: ResourceReservationBinding): TerminalReservationBindResult {
    const validation = TerminalReservationBindingSchema.safeParse(binding)
    if (!validation.success) {
      throw new Error(`Invalid terminal reservation binding: ${validation.error.message}`)
    }
    const existing = this.inspect(handle, binding)
    if (existing) {
      return existing
    }
    const nextByHandle = new Map(this.byHandle).set(handle, binding)
    const nextHandleByKey = new Map(this.handleByKey).set(binding.key, handle)
    this.persist(nextByHandle)
    this.replaceState(nextByHandle, nextHandleByKey)
    return { outcome: 'bound' }
  }

  bind(handle: string, binding: ResourceReservationBinding): TerminalReservationBindResult {
    return this.claim(handle, binding)
  }

  /** Releases only the exact claim owned by a failed create attempt. */
  release(handle: string, binding: ResourceReservationBinding): void {
    if (this.byHandle.get(handle) !== binding || this.handleByKey.get(binding.key) !== handle) {
      return
    }
    this.remove(handle, binding.key)
  }

  /** Permanently retires the claim when its terminal is explicitly destroyed. */
  retire(handle: string): void {
    const binding = this.byHandle.get(handle)
    if (binding) {
      this.remove(handle, binding.key)
    }
  }

  assertBindable(handle: string, request: ResourceReservationRequest): string | null {
    const result = this.inspect(handle, request)
    return result?.outcome === 'conflict' ? result.message : null
  }

  get(handle: string): ResourceReservationBinding | undefined {
    return this.byHandle.get(handle)
  }

  private inspect(
    handle: string,
    request: ResourceReservationRequest
  ): Exclude<TerminalReservationBindResult, { outcome: 'bound' }> | null {
    const existingHandle = this.handleByKey.get(request.key)
    const existing = existingHandle ? this.byHandle.get(existingHandle) : undefined
    if (!existing || !existingHandle) {
      return null
    }
    if (existingHandle !== handle || !resourceReservationBindingMatchesRequest(existing, request)) {
      return {
        outcome: 'conflict',
        message: describeResourceReservationConflict(existing, request, existingHandle)
      }
    }
    return { outcome: 'replay', binding: existing }
  }

  private hydrate(
    storagePath: string
  ): [Map<string, ResourceReservationBinding>, Map<string, string>] {
    let parsed: unknown
    try {
      parsed = JSON.parse(readFileSync(storagePath, 'utf8'))
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return [new Map(), new Map()]
      }
      throw error
    }
    if (!Array.isArray(parsed)) {
      throw new Error(`Invalid terminal reservation store: ${storagePath}`)
    }
    const byHandle = new Map<string, ResourceReservationBinding>()
    const handleByKey = new Map<string, string>()
    for (const [index, entry] of parsed.entries()) {
      const result = TerminalReservationEntrySchema.safeParse(entry)
      if (!result.success) {
        throw new Error(
          `Invalid terminal reservation store at entry ${index}: ${storagePath}: ${result.error.message}`
        )
      }
      const { handle, binding } = result.data
      if (byHandle.has(handle)) {
        throw new Error(
          `Invalid terminal reservation store at entry ${index}: duplicate handle "${handle}": ${storagePath}`
        )
      }
      if (handleByKey.has(binding.key)) {
        throw new Error(
          `Invalid terminal reservation store at entry ${index}: duplicate key "${binding.key}": ${storagePath}`
        )
      }
      byHandle.set(handle, binding)
      handleByKey.set(binding.key, handle)
    }
    return [byHandle, handleByKey]
  }

  private remove(handle: string, key: string): void {
    const nextByHandle = new Map(this.byHandle)
    const nextHandleByKey = new Map(this.handleByKey)
    nextByHandle.delete(handle)
    nextHandleByKey.delete(key)
    this.persist(nextByHandle)
    this.replaceState(nextByHandle, nextHandleByKey)
  }

  private replaceState(
    byHandle: ReadonlyMap<string, ResourceReservationBinding>,
    handleByKey: ReadonlyMap<string, string>
  ): void {
    this.byHandle.clear()
    this.handleByKey.clear()
    for (const [handle, binding] of byHandle) {
      this.byHandle.set(handle, binding)
    }
    for (const [key, handle] of handleByKey) {
      this.handleByKey.set(key, handle)
    }
  }

  private persist(entriesByHandle: ReadonlyMap<string, ResourceReservationBinding>): void {
    if (!this.storagePath) {
      return
    }
    mkdirSync(dirname(this.storagePath), { recursive: true })
    const temporaryPath = `${this.storagePath}.tmp`
    const entries = [...entriesByHandle].map(([handle, binding]) => ({ handle, binding }))
    writeFileSync(temporaryPath, `${JSON.stringify(entries)}\n`, { mode: 0o600 })
    renameSync(temporaryPath, this.storagePath)
  }
}
