import type { AgentJournalRenderItem } from '../../../shared/agent-session/journal/agent-session-journal-types'
import type { JournalOutcome } from './outcomes/journal-outcome-codec'

export type JournalOutcomeItemSource = Readonly<{
  generation: number
  sequence: number
  key: string
  format: number
  bytes: number
}>

export type JournalOutcomeItemAdmission = (
  item: AgentJournalRenderItem,
  record: JournalOutcome,
  generation: number
) => AgentJournalRenderItem

/** Admission owns the parsed graph; every route out of its wrapper retains mutation tracking. */
export class JournalOutcomeItemProvenance {
  private readonly admitted = new WeakMap<
    object,
    { source: JournalOutcomeItemSource; dirty: boolean }
  >()

  readonly capture: JournalOutcomeItemAdmission = (item, record, generation) => {
    const proof = {
      source: Object.freeze({
        generation,
        sequence: record.seq,
        key: record.key,
        format: record.format,
        bytes: Buffer.byteLength(record.json)
      }),
      dirty: false
    }
    const wrappers = new WeakMap<object, object>()
    const wrap = <T extends object>(value: T): T => {
      const previous = wrappers.get(value)
      if (previous) {
        // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: each wrapper preserves its original JSON object's type.
        return previous as T
      }
      const proxy = new Proxy(value, {
        get(target, key, receiver) {
          // oxlint-disable-next-line anti-slop/no-reflect-get -- The proxy must preserve normal getters and array operations.
          const child: unknown = Reflect.get(target, key, receiver)
          const descriptor = Reflect.getOwnPropertyDescriptor(target, key)
          if (descriptor && !descriptor.configurable && descriptor.writable === false) {
            return child
          }
          return typeof child === 'object' && child !== null ? wrap(child) : child
        },
        getOwnPropertyDescriptor(target, key) {
          const descriptor = Reflect.getOwnPropertyDescriptor(target, key)
          const child: unknown = descriptor?.value
          if (descriptor && !descriptor.configurable) {
            if (typeof child === 'object' && child !== null) {
              proof.dirty = true
            }
            return descriptor
          }
          return descriptor && typeof child === 'object' && child !== null
            ? { ...descriptor, value: wrap(child) }
            : descriptor
        },
        set(target, key, value) {
          proof.dirty = true
          return Reflect.set(target, key, value)
        },
        defineProperty(target, key, descriptor) {
          proof.dirty = true
          return Reflect.defineProperty(target, key, descriptor)
        },
        deleteProperty(target, key) {
          proof.dirty = true
          return Reflect.deleteProperty(target, key)
        },
        setPrototypeOf(target, prototype) {
          proof.dirty = true
          return Reflect.setPrototypeOf(target, prototype)
        },
        preventExtensions(target) {
          proof.dirty = true
          return Reflect.preventExtensions(target)
        }
      })
      wrappers.set(value, proxy)
      wrappers.set(proxy, proxy)
      return proxy
    }
    const wrapped = wrap(item)
    this.admitted.set(wrapped, proof)
    return wrapped
  }

  source(item: AgentJournalRenderItem, key: string): JournalOutcomeItemSource | undefined {
    const proof = this.admitted.get(item)
    return proof && !proof.dirty && proof.source.key === key ? proof.source : undefined
  }
}
