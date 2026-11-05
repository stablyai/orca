import { createHash, randomUUID } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import { serializeCompleteProfileStateDomains } from './profile-state-authority-writes'
import {
  applySecretSentinelSubstitutions,
  type SecretSentinelSubstitution
} from './secret-sentinel-substitution'

/** Keep the legacy implementation as an independent byte/hash oracle. */
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
  return { payload: Buffer.from(payload, 'utf8'), stateHash }
}

function expectIdenticalToPrevious(
  serialized: string,
  subs: readonly SecretSentinelSubstitution[],
  degradedPrefix = ''
): void {
  const before = previousImplementation(serialized, subs, degradedPrefix)
  const after = applySecretSentinelSubstitutions(serialized, subs, degradedPrefix)
  const text = applySecretSentinelSubstitutions(serialized, subs, degradedPrefix, 'text')
  expect(after.payload.equals(before.payload)).toBe(true)
  expect(after.stateHash).toBe(before.stateHash)
  expect(text.payload).toBe(before.payload.toString('utf8'))
  expect(text.stateHash).toBe(before.stateHash)
}

function sentinel(): string {
  return `orca-secret-slot-${randomUUID()}`
}

describe('complete profile domain serialization', () => {
  it('preserves escaped domain names, omission and the keys passed to toJSON', () => {
    const domain = '雪"\\\ud800'
    const state = {
      [domain]: {
        toJSON(key: string) {
          return { key, nested: { toJSON: (nestedKey: string) => nestedKey } }
        }
      },
      omitted: undefined,
      nullable: null,
      history: [{ id: 'z' }, { id: 'a' }]
    }

    const serialized = serializeCompleteProfileStateDomains(state, [], '')

    expect(serialized.payload.toString('utf8')).toBe(JSON.stringify(state))
    expect(serialized.domains.map(({ domain }) => domain)).toEqual([domain, 'nullable', 'history'])
    expect(JSON.parse(serialized.payload.toString('utf8'))).toMatchObject({
      [domain]: { key: domain, nested: 'nested' },
      nullable: null
    })
  })

  it('keeps the complete hash stable across ciphertext changes and sensitive to plaintext and absence', () => {
    const slot = sentinel()
    const state = {
      settings: { cookie: slot },
      future: { shadow: 'ciphertext-one' },
      nullable: null
    }
    const firstSub = [{ sentinel: slot, blob: 'ciphertext-one', hashValue: 'secret' }]
    const first = serializeCompleteProfileStateDomains(state, firstSub, '')
    const second = serializeCompleteProfileStateDomains(
      state,
      [{ sentinel: slot, blob: 'ciphertext-two', hashValue: 'secret' }],
      ''
    )

    expect(first.payload).toEqual(
      applySecretSentinelSubstitutions(JSON.stringify(state), firstSub, '').payload
    )
    expect(second.payload).not.toEqual(first.payload)
    expect(second.stateHash).toBe(first.stateHash)
    expect(JSON.parse(second.payload.toString('utf8')).future).toEqual({ shadow: 'ciphertext-one' })
    expect(
      serializeCompleteProfileStateDomains(
        state,
        [{ sentinel: slot, blob: 'ciphertext-one', hashValue: 'changed-secret' }],
        ''
      ).stateHash
    ).not.toBe(first.stateHash)
    expect(
      serializeCompleteProfileStateDomains({ ...state, nullable: undefined }, firstSub, '')
        .stateHash
    ).not.toBe(first.stateHash)
  })

  it('retains unknown own keys and encodes bytes only when a complete payload is requested', () => {
    const state = Object.fromEntries([
      ['9', 9],
      ['3', 3],
      ['z', null],
      ['__proto__', { own: true }],
      ['constructor', false],
      ['future', { text: '雪😀\ud800', absent: undefined }]
    ])
    const expected = JSON.stringify(state)
    const encode = vi.spyOn(Buffer, 'from')
    try {
      const serialized = serializeCompleteProfileStateDomains(state, [], 'safeStorage-degraded\0')
      expect(serialized.domains.map(({ domain }) => domain)).toEqual(Object.keys(state))
      expect(serialized.domains.find(({ domain }) => domain === '__proto__')?.payload).toBe(
        '{"own":true}'
      )
      expect(encode).not.toHaveBeenCalled()
      expect(serialized.payload.toString('utf8')).toBe(expected)
      expect(encode).toHaveBeenCalledExactlyOnceWith(expected, 'utf8')
    } finally {
      encode.mockRestore()
    }
  })
})

describe('applySecretSentinelSubstitutions', () => {
  it('produces bytes and a hash identical to the previous implementation', () => {
    const subs: SecretSentinelSubstitution[] = [
      { sentinel: sentinel(), blob: 'djEwY2lwaGVy', hashValue: 'cookie-value' },
      {
        sentinel: sentinel(),
        // Replacement metacharacters and JSON escapes must survive without interpolation or double escaping.
        blob: 'A+/=$&$1$`\\x "quoted" |.*?[](){}^',
        hashValue: 'http://proxy.example:8080/?a=b&c=$&'
      },
      { sentinel: sentinel(), blob: '', hashValue: 'https://kagi.com/session?t=abc' }
    ]
    const state = {
      settings: { opencodeSessionCookie: subs[0].sentinel, httpProxyUrl: subs[1].sentinel },
      ui: { browserKagiSessionLink: subs[2].sentinel },
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
      // Multibyte characters beside sentinel boundaries expose incorrect byte offsets.
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

  it('leaves domains without matching sentinels byte-identical', () => {
    const serialized = JSON.stringify({ future: { output: '雪😀\ud800', present: null } })
    const subs = [{ sentinel: 'missing-slot', blob: 'cipher', hashValue: 'plain' }]
    expectIdenticalToPrevious(serialized, subs, 'safeStorage-degraded\0')
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

    // Count whole-state replacements and UTF-8 encodes at their allocation sites.
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
    const text = counted(() => applySecretSentinelSubstitutions(serialized, subs, '', 'text'))

    expect(before.fullStateReplaces).toBe(subs.length * 2)
    expect(after.fullStateReplaces).toBe(0)
    expect(text.fullStateReplaces).toBe(0)
    expect(before.encodedChars).toBeGreaterThan(serialized.length * 1.9)
    expect(after.encodedChars).toBeLessThan(serialized.length * 1.1)
    expect(after.encodedChars).toBeGreaterThan(serialized.length * 0.9)
    expect(text.encodedChars).toBeLessThan(serialized.length * 1.1)
    expect(text.encodedChars).toBeGreaterThan(serialized.length * 0.9)
  })
})
