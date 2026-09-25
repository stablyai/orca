import { describe, expect, it } from 'vitest'
import { SshPtyClosedGenerationRanges } from './ssh-pty-closed-generation-ranges'

const HOSTS = 8
const RECONNECTS = 20_000

function lcg(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state = (state * 1_664_525 + 1_013_904_223) >>> 0
    return state / 0x1_0000_0000
  }
}

// Provider generations come from one process-global counter shared by every SSH target
// (ssh-pty-output-intake-registry.ts), so lower-numbered generations are routinely still live on a
// different host. The closed set must answer exactly; a high-water approximation would reject a
// healthy target's output the moment any other target disconnected.
describe('closed provider generations across concurrent SSH targets', () => {
  it('keeps a lower live generation admissible after a higher one closes', () => {
    const closed = new SshPtyClosedGenerationRanges()

    // Host A holds generation 1 and stays connected; host B holds 2 and disconnects.
    closed.add(2)

    expect(closed.has(2)).toBe(true)
    expect(closed.has(1)).toBe(false)
  })

  it('collapses to one range when two targets take turns reconnecting', () => {
    // Each reconnect closes the generation it is replacing, so alternating hosts still produce a
    // contiguous closed run -- interleaving alone does not fragment the list.
    const closed = new SshPtyClosedGenerationRanges()
    let nextGeneration = 1
    const live = [nextGeneration++, nextGeneration++]
    for (let reconnect = 0; reconnect < RECONNECTS; reconnect += 1) {
      const host = reconnect % live.length
      closed.add(live[host]!)
      live[host] = nextGeneration++
    }

    expect(closed.size).toBe(1)
    expect(closed.has(live[0]!)).toBe(false)
    expect(closed.has(live[1]!)).toBe(false)
  })

  it('bounds ranges by the live generation count, not the reconnect count', () => {
    // Eight hosts reconnecting in scrambled order, with closes landing out of order the way a
    // deferred model migration settles them. Every gap is a generation that is still live, so the
    // list can never hold more than one range per live generation plus one.
    const random = lcg(0x5eed)
    const closed = new SshPtyClosedGenerationRanges()
    let nextGeneration = 1
    const live = Array.from({ length: HOSTS }, () => nextGeneration++)
    const settling: number[] = []
    let peakRanges = 0
    for (let reconnect = 0; reconnect < RECONNECTS; reconnect += 1) {
      const host = Math.floor(random() * HOSTS)
      settling.push(live[host]!)
      live[host] = nextGeneration++
      if (settling.length > 4) {
        closed.add(settling.splice(Math.floor(random() * settling.length), 1)[0]!)
      }
      peakRanges = Math.max(peakRanges, closed.size)
    }
    for (const generation of settling) {
      closed.add(generation)
    }

    expect(peakRanges).toBeLessThanOrEqual(HOSTS + 4 + 1)
    expect(closed.size).toBeLessThanOrEqual(HOSTS + 1)
    for (const generation of live) {
      expect(closed.has(generation)).toBe(false)
    }
  })

  it('retains one range for every generation that is allocated and never closed', () => {
    // The honest limitation, pinned rather than assumed away: ranges compact only against closes.
    // A generation that is allocated and abandoned without a close leaves a permanent gap, so this
    // structure is bounded by unclosed generations -- not by anything the reconnect loop does.
    const closed = new SshPtyClosedGenerationRanges()
    let nextGeneration = 1
    for (let reconnect = 0; reconnect < 5_000; reconnect += 1) {
      nextGeneration += 1
      closed.add(nextGeneration++)
    }

    expect(closed.size).toBe(5_000)
  })
})
