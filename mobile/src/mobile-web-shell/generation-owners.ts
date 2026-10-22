export type GenerationOwner = { release(): void }

type OwnerRecord = { released: boolean; generation: string | null }

export function createGenerationOwners(onRelease: () => void) {
  const owners = new WeakMap<GenerationOwner, OwnerRecord>()
  const counts = new Map<string, number>()
  const keyOf = (hostKey: string, buildId: string) => `${hostKey}/${buildId}`
  function drop(key: string): void {
    const count = (counts.get(key) ?? 1) - 1
    if (count === 0) {
      counts.delete(key)
    } else {
      counts.set(key, count)
    }
  }

  return {
    create(): GenerationOwner {
      const record: OwnerRecord = { released: false, generation: null }
      const owner = {
        release() {
          if (record.released) {
            return
          }
          record.released = true
          if (record.generation !== null) {
            drop(record.generation)
            record.generation = null
          }
          onRelease()
        }
      }
      owners.set(owner, record)
      return owner
    },
    retain(owner: GenerationOwner | undefined, hostKey: string, buildId: string): void {
      if (owner === undefined) {
        return
      }
      const record = owners.get(owner)
      if (record === undefined) {
        throw new Error('generation owner belongs to another store')
      }
      if (record.released) {
        return
      }
      const key = keyOf(hostKey, buildId)
      if (record.generation !== key) {
        if (record.generation !== null) {
          drop(record.generation)
        }
        record.generation = key
        counts.set(key, (counts.get(key) ?? 0) + 1)
      }
    },
    holds: (hostKey: string, buildId: string) => counts.has(keyOf(hostKey, buildId)),
    holdsHost: (hostKey: string) => [...counts.keys()].some((key) => key.startsWith(`${hostKey}/`))
  }
}
