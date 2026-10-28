// Interns the 5-grams url_pattern_index keys rules by (url_pattern_index.h kNGramSize) as dense
// ids shared by every ruleset, so a request URL's n-grams are hashed once no matter how many
// rulesets are enabled. Keys are lower-case ASCII; a 5-gram packs into 7 + 28 bits.

const NGRAM_SIZE = 5

const EMPTY = 0

class NgramDictionary {
  private capacity = 1 << 12
  private high = new Uint8Array(this.capacity)
  private low = new Int32Array(this.capacity)
  private ids = new Int32Array(this.capacity)
  private count = 0
  // Per-lookup dedupe stamps, indexed by id.
  private stamps = new Uint32Array(this.capacity)
  private epoch = 0

  get size(): number {
    return this.count
  }

  /** Id for an n-gram, creating it when `create` is set; -1 when absent. */
  lookup(high: number, low: number, create: boolean): number {
    const mask = this.capacity - 1
    let slot = hash(high, low) & mask
    for (;;) {
      const stored = this.high[slot]
      if (stored === EMPTY) {
        if (!create) {
          return -1
        }
        return this.insert(slot, high, low)
      }
      if (stored === high + 1 && this.low[slot] === low) {
        return this.ids[slot]
      }
      slot = (slot + 1) & mask
    }
  }

  private insert(slot: number, high: number, low: number): number {
    const id = this.count++
    this.high[slot] = high + 1
    this.low[slot] = low
    this.ids[slot] = id
    if (this.count * 2 > this.capacity) {
      this.grow()
    }
    return id
  }

  private grow(): void {
    const { high, low, ids } = this
    this.capacity *= 2
    this.high = new Uint8Array(this.capacity)
    this.low = new Int32Array(this.capacity)
    this.ids = new Int32Array(this.capacity)
    const stamps = new Uint32Array(this.capacity)
    stamps.set(this.stamps)
    this.stamps = stamps
    const mask = this.capacity - 1
    for (let i = 0; i < high.length; i++) {
      if (high[i] === EMPTY) {
        continue
      }
      let slot = hash(high[i] - 1, low[i]) & mask
      while (this.high[slot] !== EMPTY) {
        slot = (slot + 1) & mask
      }
      this.high[slot] = high[i]
      this.low[slot] = low[i]
      this.ids[slot] = ids[i]
    }
  }

  /** Distinct known n-gram ids in a lower-cased URL spec, in first-seen order. */
  urlNgramIds(lowerSpec: string): number[] {
    this.epoch = (this.epoch + 1) >>> 0
    if (this.epoch === 0) {
      this.stamps.fill(0)
      this.epoch = 1
    }
    const found: number[] = []
    let length = 0
    let low = 0
    let high = 0
    for (let i = 0; i < lowerSpec.length; i++) {
      const code = lowerSpec.charCodeAt(i)
      if (code > 0x7f) {
        length = 0
        low = 0
        continue
      }
      high = (low >>> 21) & 0x7f
      low = ((low << 7) & 0x0fffffff) | code
      if (++length < NGRAM_SIZE) {
        continue
      }
      const id = this.lookup(high, low, false)
      if (id !== -1 && this.stamps[id] !== this.epoch) {
        this.stamps[id] = this.epoch
        found.push(id)
      }
    }
    return found
  }
}

function hash(high: number, low: number): number {
  return Math.imul(low ^ Math.imul(high + 1, 0x9e3779b1), 0x85ebca6b) ^ (low >>> 15)
}

const dictionary = new NgramDictionary()

export function dnrNgramDictionary(): NgramDictionary {
  return dictionary
}

/** Every 5-gram of a lower-cased pattern, skipping windows that cross '*' or '^'. */
export function patternNgrams(pattern: string): { high: number; low: number; start: number }[] {
  const grams: { high: number; low: number; start: number }[] = []
  let length = 0
  let low = 0
  for (let i = 0; i < pattern.length; i++) {
    const code = pattern.charCodeAt(i)
    if (code === 42 || code === 94 || code > 0x7f) {
      length = 0
      low = 0
      continue
    }
    const high = (low >>> 21) & 0x7f
    low = ((low << 7) & 0x0fffffff) | code
    if (++length >= NGRAM_SIZE) {
      grams.push({ high, low, start: i - NGRAM_SIZE + 1 })
    }
  }
  return grams
}
