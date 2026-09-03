/**
 * The bar for this change is "the bytes on disk did not move". Every case below runs the exact
 * loop `applySecretSentinelSubstitutions` replaced — reproduced in `previousImplementation` — and
 * compares payload bytes and guard hash, because a drifting hash silently disables the no-op write
 * guard and a drifting payload is corrupted persisted state.
 */
import { createHash, randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import {
  applySecretSentinelSubstitutions,
  type SecretSentinelSubstitution
} from './secret-sentinel-substitution'

/** Verbatim from state-serialization-secret-handling.ts before this change. */
function previousImplementation(
  serialized: string,
  secretSubs: readonly SecretSentinelSubstitution[],
  degradedPrefix: string
): { payload: Buffer; stateHash: string } {
  let payload = serialized
  let hashInput = serialized
  for (const { sentinel, blob, hashValue } of secretSubs) {
    const escapedSentinel = JSON.stringify(sentinel).slice(1, -1)
    payload = payload.replace(escapedSentinel, () => JSON.stringify(blob).slice(1, -1))
    hashInput = hashInput.replace(escapedSentinel, () => JSON.stringify(hashValue).slice(1, -1))
  }
  const stateHash = createHash('sha1').update(degradedPrefix).update(hashInput).digest('hex')
  // `handle.writeFile(payload, 'utf-8')` is what turned the string into bytes.
  return { payload: Buffer.from(payload, 'utf8'), stateHash }
}

function expectIdenticalToPrevious(
  serialized: string,
  subs: readonly SecretSentinelSubstitution[],
  degradedPrefix = ''
): void {
  const before = previousImplementation(serialized, subs, degradedPrefix)
  const after = applySecretSentinelSubstitutions(serialized, subs, degradedPrefix)
  expect(after.payload.equals(before.payload)).toBe(true)
  expect(after.stateHash).toBe(before.stateHash)
}

function sentinel(): string {
  return `orca-secret-slot-${randomUUID()}`
}

describe('applySecretSentinelSubstitutions', () => {
  it('produces bytes and a hash identical to the previous implementation', () => {
    const subs: SecretSentinelSubstitution[] = [
      { sentinel: sentinel(), blob: 'djEwY2lwaGVy', hashValue: 'cookie-value' },
      {
        sentinel: sentinel(),
        // Regex-special *and* JSON-escapable, which is the pair that breaks a naive rewrite:
        // `$&` would splice the match back in under string-form replace, and the backslash and
        // quote have to survive `JSON.stringify(...).slice(1, -1)` unchanged.
        blob: 'A+/=$&$1$`\\x "quoted" |.*?[](){}^',
        hashValue: 'http://proxy.example:8080/?a=b&c=$&'
      },
      { sentinel: sentinel(), blob: '', hashValue: 'https://kagi.com/session?t=abc' }
    ]
    const state = {
      settings: { opencodeSessionCookie: subs[0].sentinel, httpProxyUrl: subs[1].sentinel },
      ui: { browserKagiSessionLink: subs[2].sentinel },
      // Adjacent content that must not shift: a near-miss prefix, and JSON escapes either side.
      noise: ['orca-secret-slot-', 'a\\b"c\n\t', subs[0].sentinel.slice(0, -1)]
    }
    expectIdenticalToPrevious(JSON.stringify(state), subs)
  })

  it('stays identical when the state holds multi-byte and escaped characters', () => {
    const subs: SecretSentinelSubstitution[] = [
      { sentinel: sentinel(), blob: 'blob-é', hashValue: 'plain-é' },
      { sentinel: sentinel(), blob: '😀', hashValue: '中文' }
    ]
    const state = {
      // Segment boundaries land next to these, so a wrong split would corrupt the encode.
      before: 'é中文😀',
      a: subs[0].sentinel,
      between: '😀  ',
      b: subs[1].sentinel,
      after: '😀'
    }
    expectIdenticalToPrevious(JSON.stringify(state), subs)
  })

  it('stays identical with no substitutions and with the degraded-storage prefix', () => {
    const state = JSON.stringify({ settings: { httpProxyUrl: '' }, big: 'x'.repeat(4096) })
    expectIdenticalToPrevious(state, [])
    expectIdenticalToPrevious(state, [], 'safeStorage-degraded\0')

    const subs = [{ sentinel: sentinel(), blob: 'b', hashValue: 'h' }]
    expectIdenticalToPrevious(
      JSON.stringify({ s: subs[0].sentinel }),
      subs,
      'safeStorage-degraded\0'
    )
  })

  it('escapes regex metacharacters in the sentinel itself', () => {
    // Not reachable from a UUID sentinel, but the alternation must not be able to become a pattern.
    const subs = [{ sentinel: 'a.b*c(d)|e[f]', blob: 'BLOB', hashValue: 'HASH' }]
    const serialized = JSON.stringify({ real: subs[0].sentinel, decoy: 'axbxxcXdX_eXfX' })
    expectIdenticalToPrevious(serialized, subs)
    expect(
      applySecretSentinelSubstitutions(serialized, subs, '').payload.toString('utf8')
    ).toContain('axbxxcXdX_eXfX')
  })

  it('substitutes every occurrence when a sentinel repeats', () => {
    // Cannot happen today (a sentinel is a UUID minted after the state is assembled, so it appears
    // exactly once), but the old first-match-only `String.replace` would have written a raw
    // sentinel to disk in place of a secret if it ever did. The alternation is global instead.
    const subs = [{ sentinel: sentinel(), blob: 'CIPHER', hashValue: 'PLAIN' }]
    const serialized = JSON.stringify({ a: subs[0].sentinel, b: subs[0].sentinel })
    const { payload } = applySecretSentinelSubstitutions(serialized, subs, '')
    expect(payload.toString('utf8')).toBe(JSON.stringify({ a: 'CIPHER', b: 'CIPHER' }))
    expect(payload.toString('utf8')).not.toContain(subs[0].sentinel)
  })

  it('copies and UTF-8 encodes the full state once, not once per sentinel per side', () => {
    const subs: SecretSentinelSubstitution[] = Array.from({ length: 3 }, () => ({
      sentinel: sentinel(),
      blob: 'CIPHERTEXT',
      hashValue: 'plaintext'
    }))
    const serialized = JSON.stringify({
      pad: 'x'.repeat(200_000),
      a: subs[0].sentinel,
      b: subs[1].sentinel,
      c: subs[2].sentinel
    })
    const FULL_STATE = 100_000

    // Both costs are observable at their sources: a `String.replace` whose receiver is the whole
    // state allocates another copy of it, and every string handed to `Buffer.from` or `hash.update`
    // is one full UTF-8 encode pass on the main thread.
    const counted = (run: () => unknown): { fullStateReplaces: number; encodedChars: number } => {
      const realReplace = String.prototype.replace
      const realBufferFrom = Buffer.from
      const hashProto = Object.getPrototypeOf(createHash('sha1')) as {
        update: (...args: unknown[]) => unknown
      }
      const realUpdate = hashProto.update
      const counts = { fullStateReplaces: 0, encodedChars: 0 }
      String.prototype.replace = function (this: string, ...args: unknown[]) {
        if (this.length >= FULL_STATE) {
          counts.fullStateReplaces++
        }
        return realReplace.apply(this, args as never)
      } as typeof String.prototype.replace
      Buffer.from = function (...args: unknown[]) {
        if (typeof args[0] === 'string') {
          counts.encodedChars += args[0].length
        }
        return (realBufferFrom as (...a: unknown[]) => Buffer).apply(Buffer, args)
      } as typeof Buffer.from
      hashProto.update = function (this: unknown, ...args: unknown[]) {
        if (typeof args[0] === 'string') {
          counts.encodedChars += args[0].length
        }
        return realUpdate.apply(this, args)
      }
      try {
        run()
      } finally {
        String.prototype.replace = realReplace
        Buffer.from = realBufferFrom
        hashProto.update = realUpdate
      }
      return counts
    }

    const before = counted(() => previousImplementation(serialized, subs, ''))
    const after = counted(() => applySecretSentinelSubstitutions(serialized, subs, ''))

    // Two `String.replace` calls over the whole state per sentinel — payload and hash input.
    expect(before.fullStateReplaces).toBe(subs.length * 2)
    expect(after.fullStateReplaces).toBe(0)
    // The old path encoded the state twice: once for sha1, once for the file write.
    expect(before.encodedChars).toBeGreaterThan(serialized.length * 1.9)
    expect(after.encodedChars).toBeLessThan(serialized.length * 1.1)
    expect(after.encodedChars).toBeGreaterThan(serialized.length * 0.9)
  })
})
