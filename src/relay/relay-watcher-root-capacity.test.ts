import { describe, expect, it } from 'vitest'
import {
  MAX_RELAY_WATCH_ROOT_KEY_BYTES,
  MAX_RELAY_WATCH_ROOT_KEYS_BYTES,
  MAX_RELAY_WATCH_ROOTS,
  assertRelayWatcherRootCapacity
} from './relay-watcher-root-capacity'

function keyWithBytes(label: string, bytes: number): string {
  return `${label}${'x'.repeat(bytes - Buffer.byteLength(label))}`
}

describe('relay watcher root capacity', () => {
  it('accepts a root key at the exact UTF-8 byte boundary', () => {
    const root = keyWithBytes('/', MAX_RELAY_WATCH_ROOT_KEY_BYTES)

    expect(() => assertRelayWatcherRootCapacity([], [], [], root)).not.toThrow()
  })

  it('rejects a root key one byte over the boundary', () => {
    const root = keyWithBytes('/', MAX_RELAY_WATCH_ROOT_KEY_BYTES + 1)

    expect(() => assertRelayWatcherRootCapacity([], [], [], root)).toThrow(
      'File watcher root path is too long'
    )
  })

  it('rejects an oversized raw path even when normalization made its key small', () => {
    const rawPath = '/'.repeat(MAX_RELAY_WATCH_ROOT_KEY_BYTES + 1)

    expect(() => assertRelayWatcherRootCapacity([], [], [], '/', rawPath)).toThrow(
      'File watcher root path is too long'
    )
  })

  it('caps aggregate keys retained across active, pending, and failed teardowns', () => {
    const retained = Array.from({ length: 4 }, (_, index) =>
      keyWithBytes(`/${index}/`, MAX_RELAY_WATCH_ROOT_KEY_BYTES - 1)
    )
    const exactProspective = keyWithBytes('/p', 4)
    expect(
      retained.reduce((total, root) => total + Buffer.byteLength(root), 0) +
        Buffer.byteLength(exactProspective)
    ).toBe(MAX_RELAY_WATCH_ROOT_KEYS_BYTES)

    expect(() =>
      assertRelayWatcherRootCapacity(
        [retained[0]!],
        [retained[1]!],
        [retained[2]!, retained[3]!],
        exactProspective
      )
    ).not.toThrow()
    expect(() =>
      assertRelayWatcherRootCapacity(
        [retained[0]!],
        [retained[1]!],
        [retained[2]!, retained[3]!],
        `${exactProspective}x`
      )
    ).toThrow('Maximum file watcher root path memory reached')
  })

  it('keeps the existing physical watcher count boundary', () => {
    const retained = Array.from({ length: MAX_RELAY_WATCH_ROOTS }, (_, index) => `/${index}`)

    expect(() => assertRelayWatcherRootCapacity(retained, [], [], retained[0]!)).not.toThrow()
    expect(() => assertRelayWatcherRootCapacity(retained, [], [], '/overflow')).toThrow(
      'Maximum number of file watchers reached'
    )
  })
})
