import { describe, expect, it, vi } from 'vitest'
import { terminal } from './xterm-image-checkpoint-test-terminal.mjs'

const rgba = Buffer.from(Array.from({ length: 200 * 200 }, (_, i) => [i % 256, 100, 0, 255]).flat())
const encoded = rgba.toString('base64')
const write = (h, value) => h.core._core.writeSync(value)
const kitty = (command, payload = '') => `\x1b_G${command};${payload}\x1b\\`
const handler = (h) => h.addon._handlers.get('kitty')

function restore(source, target) {
  const pending = handler(source).capturePendingCheckpoint(1024 * 1024)
  const active = handler(source).captureActiveCheckpoint(1024 * 1024)
  try {
    source.core.dispose()
    handler(target).restorePendingCheckpoint(pending)
    handler(target).restoreActiveCheckpoint(active)
    return active
  } finally {
    pending.dispose()
  }
}

describe('active Kitty image checkpoint component', () => {
  it.each([
    0,
    1,
    2,
    3,
    131069,
    encoded.length - 4,
    encoded.length - 3,
    encoded.length - 2,
    encoded.length - 1,
    encoded.length
  ])('resumes a single upload cut at %i bytes using only new producer bytes', (cut) => {
    const source = terminal(),
      target = terminal()
    let active
    try {
      write(source, `\x1b_Ga=t,f=32,s=200,v=200,i=7,q=2;${encoded.slice(0, cut)}`)
      active = restore(source, target)
      write(target, `${encoded.slice(cut)}\x1b\\`)
      expect(target.kittyStorage.getImage(7).data).toEqual(new Uint8Array(rgba))
    } finally {
      active?.dispose()
      source.core.dispose()
      target.core.dispose()
    }
  })

  it.each([1, 2, 3, 131069])(
    'preserves the decoder alias after a completed prefix of %i',
    (cut) => {
      const source = terminal(),
        target = terminal()
      let active
      try {
        write(source, kitty('a=t,f=32,s=200,v=200,i=7,m=1,q=2', encoded.slice(0, cut)))
        write(source, `\x1b_Gm=1,q=2;${encoded.slice(cut, -4)}`)
        active = restore(source, target)
        expect(handler(target)._activeDecoder).toBe(
          handler(target)._pendingTransmissions.get(7).decoder
        )
        expect(handler(target)._pendingTransmissions.get(7).totalEncodedSize).toBe(cut)
        write(target, `${encoded.slice(-4)}\x1b\\${kitty('m=0,q=2')}`)
        expect(target.kittyStorage.getImage(7).data).toEqual(new Uint8Array(rgba))
        expect(handler(target)._pendingTransmissions.size).toBe(0)
      } finally {
        active?.dispose()
        source.core.dispose()
        target.core.dispose()
      }
    }
  )

  it.each(['a=t,f=32,s=200,v=200,i=', 'a=t,f=32,s=200,v=200,i=7,q=2'])(
    'resumes an incomplete control field %j',
    (control) => {
      const source = terminal(),
        target = terminal()
      let active
      try {
        write(source, `\x1b_G${control}`)
        active = restore(source, target)
        write(target, `${control.endsWith('=') ? '7,q=2' : ''};${encoded}\x1b\\`)
        expect(target.kittyStorage.getImage(7).data).toEqual(new Uint8Array(rgba))
      } finally {
        active?.dispose()
        source.core.dispose()
        target.core.dispose()
      }
    }
  )

  it('preserves deferred Base64 failure and emits its reply only on new termination', () => {
    const source = terminal(),
      target = terminal()
    let active
    try {
      write(source, `\x1b_Ga=t,f=32,s=200,v=200,i=7;${'!'.repeat(131072)}`)
      expect(handler(source)._decodeError).toBe(true)
      active = restore(source, target)
      const reply = vi.fn()
      target.core.onData(reply)
      expect(handler(target)._decodeError).toBe(true)
      write(target, '\x1b\\')
      expect(reply).toHaveBeenCalledExactlyOnceWith('\x1b_Gi=7;EINVAL:invalid base64 data\x1b\\')
      expect(target.kittyStorage.images.size).toBe(0)
      expect(handler(target)._pendingTransmissions.size).toBe(0)
    } finally {
      active?.dispose()
      source.core.dispose()
      target.core.dispose()
    }
  })

  it.each([undefined, 2147483655])('preserves automatic and high image IDs: %s', (id) => {
    const source = terminal(),
      target = terminal()
    let active
    try {
      const identify = id === undefined ? '' : `,i=${id}`
      write(source, kitty(`a=t,f=32,s=200,v=200,m=1,q=2${identify}`, encoded.slice(0, 3)))
      write(source, `\x1b_Gm=0,q=2;${encoded.slice(3, -4)}`)
      active = restore(source, target)
      write(target, `${encoded.slice(-4)}\x1b\\`)
      expect(target.kittyStorage.getImage(id ?? 1).data).toEqual(new Uint8Array(rgba))
    } finally {
      active?.dispose()
      source.core.dispose()
      target.core.dispose()
    }
  })

  it.each(['\x18', '\x1a'])(
    'cancels the restored aliased upload with %j and preserves another upload',
    (cancel) => {
      const source = terminal(),
        target = terminal()
      let active
      try {
        write(source, kitty('a=t,f=32,s=200,v=200,i=9,m=1,q=2', encoded.slice(0, 3)))
        write(source, kitty('a=t,f=32,s=200,v=200,i=7,m=1,q=2', encoded.slice(0, 3)))
        write(source, `\x1b_Gm=0,q=2;${encoded.slice(3, -4)}`)
        active = restore(source, target)
        write(target, cancel)
        expect([...handler(target)._pendingTransmissions.keys()]).toEqual([9])
        expect(handler(target)._activeDecoder).toBeNull()
        write(target, kitty('i=9,m=0,q=2', encoded.slice(3)))
        expect(target.kittyStorage.getImage(9).data).toEqual(new Uint8Array(rgba))
        expect(target.kittyStorage.images.has(7)).toBe(false)
      } finally {
        active?.dispose()
        source.core.dispose()
        target.core.dispose()
      }
    }
  )

  it('resumes a no-payload query without replying during restoration', () => {
    const source = terminal(),
      target = terminal()
    let active
    try {
      write(source, '\x1b_Ga=q,i=7')
      active = handler(source).captureActiveCheckpoint(0)
      const reply = vi.fn()
      target.core.onData(reply)
      handler(target).restoreActiveCheckpoint(active)
      expect(reply).not.toHaveBeenCalled()
      write(target, '\x1b\\')
      expect(reply).toHaveBeenCalledExactlyOnceWith('\x1b_Gi=7;OK\x1b\\')
    } finally {
      active?.dispose()
      source.core.dispose()
      target.core.dispose()
    }
  })

  it('preserves a reset-aborted active command until its remaining bytes end', () => {
    const source = terminal(),
      target = terminal()
    let active
    try {
      write(source, `\x1b_Ga=t,f=32,s=200,v=200,i=7,q=2;${encoded.slice(0, 131069)}`)
      source.addon.reset()
      active = restore(source, target)
      write(target, `${encoded.slice(131069)}\x1b\\`)
      expect(target.kittyStorage.images.size).toBe(0)
      write(target, kitty('a=t,f=32,s=200,v=200,i=8,q=2', encoded))
      expect(target.kittyStorage.getImage(8).data).toEqual(new Uint8Array(rgba))
    } finally {
      active?.dispose()
      source.core.dispose()
      target.core.dispose()
    }
  })

  it('does not capture an already completed command or another APC identifier', () => {
    const h = terminal()
    try {
      write(h, kitty('a=t,f=32,s=200,v=200,i=7,q=2', encoded).slice(0, -1))
      expect(handler(h).captureActiveCheckpoint(1024 * 1024)).toBeUndefined()
      write(h, '\\')
      write(h, '\x1b_Zunknown')
      expect(handler(h).captureActiveCheckpoint(1024 * 1024)).toBeUndefined()
    } finally {
      h.core.dispose()
    }
  })
})
