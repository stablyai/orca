import { vi } from 'vitest'
import type { TerminalIdentitySource } from './terminal-identity-source'
import { TerminalIncarnationCandidates } from './terminal-incarnation-candidates'

/** Counts only operations executing inside the actual candidate representation. */
export function meterIncarnationCandidates() {
  const counts = () => ({
    calls: 0,
    candidates: 0,
    get: 0,
    set: 0,
    delete: 0,
    keyChars: 0,
    shifted: 0
  })
  const maintenance = counts(),
    lookup = counts(),
    preparationLookup = counts()
  let reading = false
  const validation = { bindings: 0, ptys: 0, keyChars: 0 }
  let validationMaps:
    | {
        bindings: TerminalIdentitySource['incarnations']
        ptys: TerminalIdentitySource['ptys']
      }
    | undefined
  let validating = false
  let active: ReturnType<typeof counts> | undefined
  const during = <T>(phase: ReturnType<typeof counts>, action: () => T): T => {
    const previous = active
    active = phase
    phase.calls++
    try {
      return action()
    } finally {
      active = previous
    }
  }
  const get = Map.prototype.get,
    set = Map.prototype.set,
    remove = Map.prototype.delete
  const splice = Array.prototype.splice
  const prototype = TerminalIncarnationCandidates.prototype
  const first = prototype.first,
    install = prototype.set,
    forget = prototype.delete,
    clear = prototype.clear
  const spies = [
    vi.spyOn(Map.prototype, 'get').mockImplementation(function (this: Map<unknown, unknown>, key) {
      if (validating && validationMaps) {
        if (this === validationMaps.bindings) {
          validation.bindings++
        }
        if (this === validationMaps.ptys) {
          validation.ptys++
        }
        if (this === validationMaps.bindings || this === validationMaps.ptys) {
          validation.keyChars += typeof key === 'string' ? key.length : 0
        }
      }
      if (active) {
        active.get++
        active.keyChars += typeof key === 'string' ? key.length : 0
      }
      return get.call(this, key)
    }),
    vi.spyOn(Map.prototype, 'set').mockImplementation(function (
      this: Map<unknown, unknown>,
      key,
      value
    ) {
      if (active) {
        active.set++
        active.keyChars += typeof key === 'string' ? key.length : 0
      }
      return set.call(this, key, value)
    }),
    vi.spyOn(Map.prototype, 'delete').mockImplementation(function (
      this: Map<unknown, unknown>,
      key
    ) {
      if (active) {
        active.delete++
        active.keyChars += typeof key === 'string' ? key.length : 0
      }
      return remove.call(this, key)
    }),
    vi.spyOn(Array.prototype, 'splice').mockImplementation(function (
      this: unknown[],
      ...args: Parameters<typeof splice>
    ) {
      if (active) {
        active.shifted += Math.max(0, this.length - args[0] - args[1])
      }
      return splice.apply(this, args)
    }),
    vi.spyOn(prototype, 'first').mockImplementation(function (
      this: TerminalIncarnationCandidates,
      handle
    ) {
      const phase = reading ? lookup : preparationLookup
      return during(phase, () => {
        const id = first.call(this, handle)
        if (id !== undefined) {
          phase.candidates++
        }
        return id
      })
    }),
    vi.spyOn(prototype, 'set').mockImplementation(function (
      this: TerminalIncarnationCandidates,
      id,
      handle
    ) {
      return during(maintenance, () => install.call(this, id, handle))
    }),
    vi.spyOn(prototype, 'delete').mockImplementation(function (
      this: TerminalIncarnationCandidates,
      id
    ) {
      return during(maintenance, () => forget.call(this, id))
    }),
    vi.spyOn(prototype, 'clear').mockImplementation(function (this: TerminalIncarnationCandidates) {
      return during(maintenance, () => clear.call(this))
    })
  ]
  return {
    maintenance,
    lookup,
    preparationLookup,
    validation,
    validationMaps: (
      bindings: TerminalIdentitySource['incarnations'],
      ptys: TerminalIdentitySource['ptys']
    ) => {
      validationMaps = { bindings, ptys }
    },
    validate: <T>(action: () => T): T => {
      const previous = validating
      validating = true
      try {
        return action()
      } finally {
        validating = previous
      }
    },
    beginRead: () => {
      reading = true
    },
    close: () => {
      for (const spy of spies.toReversed()) {
        spy.mockRestore()
      }
    }
  }
}
