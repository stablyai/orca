import { afterEach, expect, it, vi } from 'vitest'
import {
  createPlaceholderTerminal,
  placeholderCells,
  PNG,
  render,
  TrackedBitmap,
  write,
  writeKitty
} from './xterm-kitty-placeholder-test-terminal.mjs'
afterEach(() => vi.unstubAllGlobals())

it('does not scan placeholder cells on image-free renders with cache recovery enabled', async () => {
  const h = createPlaceholderTerminal({ readKittyImage: vi.fn(async () => undefined) })
  try {
    await write(h.terminal, 'ordinary terminal text')
    const scan = vi.spyOn(h.kitty, '_placeholderCell')
    render(h)
    render(h)
    expect(scan).not.toHaveBeenCalled()
  } finally {
    h.terminal.dispose()
  }
})

it('still recovers placeholders hidden by an earlier parsed write', async () => {
  let saved
  const first = createPlaceholderTerminal({
    onKittyImageChanged: (_id, value) => {
      if (value) {
        saved = value
      }
    }
  })
  try {
    await writeKitty(first.terminal, 'a=T,f=100,i=7,U=1,c=2,r=2', PNG)
  } finally {
    first.terminal.dispose()
  }
  const read = vi.fn(async () => saved)
  const h = createPlaceholderTerminal({ readKittyImage: read })
  try {
    await write(h.terminal, placeholderCells(7))
    await write(h.terminal, '\r')
    render(h)
    await vi.waitFor(() => expect(h.kitty.getImage(7)).toBeDefined())
    expect(read).toHaveBeenCalledTimes(1)
  } finally {
    h.terminal.dispose()
  }
})

it.each([
  { name: 'lowercase full delete and re-place', selector: 'i', partial: false, replace: true },
  {
    name: 'lowercase last-placement delete and re-place',
    selector: 'i',
    partial: true,
    replace: true
  },
  {
    name: 'lowercase partial delete with a surviving placement',
    selector: 'i',
    partial: true,
    replace: false
  },
  {
    name: 'uppercase partial delete with a surviving placement',
    selector: 'I',
    partial: true,
    replace: false
  }
])(
  'recovers after $name followed by encoded-byte eviction',
  async ({ selector, partial, replace }) => {
    const saved = new Map()
    const read = vi.fn(async (id) => saved.get(id))
    const h = createPlaceholderTerminal({
      readKittyImage: read,
      onKittyImageChanged: (id, snapshot) => {
        if (snapshot) {
          saved.set(id, snapshot)
        } else {
          saved.delete(id)
        }
      }
    })
    try {
      await writeKitty(h.terminal, 'a=T,f=100,i=7,p=1,U=1,c=2,r=2', PNG)
      if (!replace) {
        await writeKitty(h.terminal, 'a=p,i=7,p=2,U=1,c=3,r=1')
      }
      await writeKitty(
        h.terminal,
        `a=d,d=${selector},i=7${partial ? `,p=${replace ? 1 : 2}` : ''},q=2`
      )
      if (replace) {
        await writeKitty(h.terminal, 'a=p,i=7,p=1,U=1,c=3,r=1')
      }
      const latest = saved.get(7)
      expect(latest).toBeDefined()
      vi.spyOn(h.storage, 'getLimit').mockReturnValue(latest.image.data.size / 1000000)
      await writeKitty(h.terminal, 'a=T,f=100,i=8,U=1,c=2,r=2', PNG)
      expect(h.kitty.getImage(7)).toBeUndefined()
      await write(h.terminal, placeholderCells(7, 1))
      render(h)
      await vi.waitFor(() => expect(h.kitty.getImage(7)).toBeDefined())
      expect(h.kitty._virtualPlacementFor(7, 1).cols).toBe(replace ? 3 : 2)
      expect(h.kitty._virtualPlacementFor(7, 2)).toBeUndefined()
      expect(read).toHaveBeenCalledTimes(1)
    } finally {
      h.terminal.dispose()
    }
  }
)

it.each(['i', 'I'])(
  'does not resurrect deleted placements from a stale cache after d=%s without re-place',
  async (selector) => {
    let stale
    const read = vi.fn(async () => stale)
    const h = createPlaceholderTerminal({
      readKittyImage: read,
      onKittyImageChanged: (_id, snapshot) => {
        if (snapshot && snapshot.image.id === 7) {
          stale = snapshot
        }
      }
    })
    try {
      await writeKitty(h.terminal, 'a=T,f=100,i=7,U=1,c=2,r=2', PNG)
      await writeKitty(h.terminal, `a=d,d=${selector},i=7,q=2`)
      vi.spyOn(h.storage, 'getLimit').mockReturnValue(stale.image.data.size / 1000000)
      await writeKitty(h.terminal, 'a=T,f=100,i=8,U=1,c=2,r=2', PNG)
      await write(h.terminal, placeholderCells(7))
      for (let frame = 0; frame < 3; frame++) {
        render(h)
        await new Promise((resolve) => setTimeout(resolve, 0))
      }
      expect(h.kitty.getImage(7)).toBeUndefined()
      expect(read).not.toHaveBeenCalled()
    } finally {
      h.terminal.dispose()
    }
  }
)

it('lazily decodes a pixel-evicted prototype without a new transmission', async () => {
  const h = createPlaceholderTerminal()
  try {
    await writeKitty(h.terminal, 'a=T,f=100,i=7,U=1,c=2,r=2', PNG)
    await write(h.terminal, placeholderCells(7))
    h.storage._pixelLimit = 200
    await writeKitty(h.terminal, 'a=T,f=100,i=8,U=1,c=2,r=2', PNG)
    expect(h.bitmaps[0].close).toHaveBeenCalledOnce()
    render(h)
    await vi.waitFor(() => expect(h.bitmaps).toHaveLength(3))
    await vi.waitFor(() => expect(render(h)).toHaveLength(2))
    expect(h.storage.getUsage()).toBeLessThanOrEqual(0.0008)
  } finally {
    h.terminal.dispose()
  }
})

it('recovers after an alternate-buffer round trip empties the entire pixel store', async () => {
  const h = createPlaceholderTerminal()
  try {
    await write(h.terminal, '\x1b[?1049h')
    await writeKitty(h.terminal, 'a=T,f=100,i=7,U=1,c=2,r=2', PNG)
    await write(h.terminal, `\x1b[?1049l\x1b[?1049h${placeholderCells(7)}`)
    expect(h.storage._images.size).toBe(0)
    render(h)
    await vi.waitFor(() => expect(h.storage._images.size).toBe(1))
    h.renderer._layers.set('top', {
      drawImage: h.drawImage,
      clearRect() {},
      canvas: { remove() {} }
    })
    expect(render(h)).toHaveLength(2)
  } finally {
    h.terminal.dispose()
  }
})

it('does not resurrect a deleted prototype while its recovery decode is in flight', async () => {
  const h = createPlaceholderTerminal()
  try {
    await writeKitty(h.terminal, 'a=T,f=100,i=7,U=1,c=2,r=2', PNG)
    await write(h.terminal, placeholderCells(7))
    h.storage._evictOldest(32_000_000)
    let complete
    h.decode.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          complete = resolve
        })
    )
    render(h)
    await vi.waitFor(() => expect(complete).toBeTypeOf('function'))
    await writeKitty(h.terminal, 'a=d,d=I,i=7,q=2')
    const bitmap = new TrackedBitmap()
    complete(bitmap)
    await vi.waitFor(() => expect(bitmap.close).toHaveBeenCalledOnce())
    expect(h.storage._images.size).toBe(0)
    expect(h.kitty._virtualPlacements.size).toBe(0)
  } finally {
    h.terminal.dispose()
  }
})

it('restores only referenced images after a new renderer replays placeholder text', async () => {
  const saved = new Map()
  const first = createPlaceholderTerminal({
    onKittyImageChanged: (id, image) => {
      if (image) {
        saved.set(id, image)
      } else {
        saved.delete(id)
      }
    }
  })
  await writeKitty(first.terminal, 'a=T,f=100,i=7,U=1,c=2,r=2', PNG)
  first.terminal.dispose()
  const read = vi.fn(async (id) => saved.get(id))
  const second = createPlaceholderTerminal({ readKittyImage: read })
  try {
    expect(second.decode).not.toHaveBeenCalled()
    await write(second.terminal, placeholderCells(7))
    render(second)
    await vi.waitFor(() => expect(second.kitty.getImage(7)).toBeDefined())
    render(second)
    await vi.waitFor(() => expect(second.storage._images.size).toBe(1))
    second.renderer._layers.set('top', {
      drawImage: second.drawImage,
      clearRect() {},
      canvas: { remove() {} }
    })
    expect(render(second)).toHaveLength(2)
    expect(read).toHaveBeenCalledTimes(1)
  } finally {
    second.terminal.dispose()
  }
})

it.each([0, 256])(
  'does not rewrite the replay cache while restoring with %i other placements',
  async (count) => {
    let snapshot
    const first = createPlaceholderTerminal({
      onKittyImageChanged: (_id, value) => {
        if (value) {
          snapshot = value
        }
      }
    })
    await writeKitty(first.terminal, 'a=T,f=100,i=7,U=1,c=2,r=2', PNG)
    first.terminal.dispose()
    const changed = vi.fn()
    const h = createPlaceholderTerminal({
      readKittyImage: async () => snapshot,
      onKittyImageChanged: changed
    })
    try {
      if (count) {
        h.kitty.restoreSnapshot({
          image: { ...snapshot.image, id: 8 },
          placements: Array.from({ length: count }, (_, placementId) => ({
            ...snapshot.placements[0],
            placementId
          }))
        })
        changed.mockClear()
      }
      await write(h.terminal, placeholderCells(7))
      render(h)
      await vi.waitFor(() => expect(h.kitty.getImage(7)).toBeDefined())
      expect(changed).not.toHaveBeenCalled()
      expect(snapshot.placements).toHaveLength(1)
    } finally {
      h.terminal.dispose()
    }
  }
)

it('lets new uploads win over an old asynchronous replay lookup', async () => {
  let finish
  const h = createPlaceholderTerminal({
    readKittyImage: () =>
      new Promise((resolve) => {
        finish = resolve
      })
  })
  try {
    await write(h.terminal, placeholderCells(7))
    render(h)
    await writeKitty(h.terminal, 'a=T,f=100,i=7,U=1,c=3,r=1', PNG)
    const current = h.kitty.getImage(7)
    finish({
      image: current,
      placements: [{ placementId: 0, cols: 99, rows: 99, command: { unicodePlaceholder: 1 } }]
    })
    await Promise.resolve()
    await Promise.resolve()
    expect(h.kitty.getImage(7)).toBe(current)
    expect(h.kitty._virtualPlacementFor(7, 0).cols).toBe(3)
  } finally {
    h.terminal.dispose()
  }
})

it('does not resurrect an old lookup when the replacement upload is evicted before it returns', async () => {
  const saved = new Map()
  const changed = (id, snapshot) => {
    if (snapshot) {
      saved.set(id, snapshot)
    } else {
      saved.delete(id)
    }
  }
  const first = createPlaceholderTerminal({ onKittyImageChanged: changed })
  await writeKitty(first.terminal, 'a=T,f=100,i=7,U=1,c=2,r=2', PNG)
  const old = saved.get(7)
  first.terminal.dispose()
  let finish
  const read = vi
    .fn(async (id) => saved.get(id))
    .mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve
        })
    )
  const h = createPlaceholderTerminal({ readKittyImage: read, onKittyImageChanged: changed })
  try {
    await write(h.terminal, placeholderCells(7))
    render(h)
    await writeKitty(h.terminal, 'a=T,f=100,i=7,U=1,c=3,r=1', PNG)
    vi.spyOn(h.storage, 'getLimit').mockReturnValue(old.image.data.size / 1000000)
    await writeKitty(h.terminal, 'a=T,f=100,i=8,U=1,c=2,r=2', PNG)
    expect(h.kitty.getImage(7)).toBeUndefined()
    finish(old)
    await Promise.resolve()
    await Promise.resolve()
    expect(h.kitty.getImage(7)).toBeUndefined()
    render(h)
    await vi.waitFor(() => expect(h.kitty.getImage(7)).toBeDefined())
    expect(h.kitty._virtualPlacementFor(7, 0).cols).toBe(3)
    expect(read).toHaveBeenCalledTimes(2)
  } finally {
    h.terminal.dispose()
  }
})

it('recovers again after a restored encoded payload is evicted by the byte budget', async () => {
  let snapshot
  const first = createPlaceholderTerminal({
    onKittyImageChanged: (_id, image) => {
      if (image) {
        snapshot = image
      }
    }
  })
  await writeKitty(first.terminal, 'a=T,f=100,i=7,U=1,c=2,r=2', PNG)
  first.terminal.dispose()
  const read = vi.fn(async () => snapshot)
  const second = createPlaceholderTerminal({ readKittyImage: read })
  try {
    vi.spyOn(second.storage, 'getLimit').mockReturnValue(snapshot.image.data.size / 1000000)
    await write(second.terminal, placeholderCells(7))
    for (let attempt = 0; attempt < 3; attempt++) {
      render(second)
      await vi.waitFor(() => expect(second.kitty.getImage(7)).toBeDefined())
      expect(read).toHaveBeenCalledTimes(attempt + 1)
      await writeKitty(second.terminal, `a=T,f=100,i=${8 + attempt},U=1,c=2,r=2`, PNG)
      expect(second.kitty.getImage(7)).toBeUndefined()
    }
  } finally {
    second.terminal.dispose()
  }
})

it('recovers a reused image ID after deletion, a new upload and byte-budget eviction', async () => {
  const saved = new Map()
  const read = vi.fn(async (id) => saved.get(id))
  const h = createPlaceholderTerminal({
    readKittyImage: read,
    onKittyImageChanged: (id, snapshot) => {
      if (snapshot) {
        saved.set(id, snapshot)
      } else {
        saved.delete(id)
      }
    }
  })
  try {
    await writeKitty(h.terminal, 'a=T,f=100,i=7,U=1,c=2,r=2', PNG)
    await writeKitty(h.terminal, 'a=d,d=I,i=7,q=2')
    await writeKitty(h.terminal, 'a=T,f=100,i=7,U=1,c=3,r=1', PNG)
    vi.spyOn(h.storage, 'getLimit').mockReturnValue(saved.get(7).image.data.size / 1000000)
    await writeKitty(h.terminal, 'a=T,f=100,i=8,U=1,c=2,r=2', PNG)
    expect(h.kitty.getImage(7)).toBeUndefined()
    await write(h.terminal, placeholderCells(7))
    render(h)
    await vi.waitFor(() => expect(h.kitty.getImage(7)).toBeDefined())
    expect(read).toHaveBeenCalledWith(7)
    expect(h.kitty._virtualPlacementFor(7, 0).cols).toBe(3)
  } finally {
    h.terminal.dispose()
  }
})

it.each(['absent', 'rejected', 'wrong id', 'oversized'])(
  'retries a %s replay lookup after a viewport change without polling the same viewport',
  async (failure) => {
    let snapshot
    const first = createPlaceholderTerminal({
      onKittyImageChanged: (_id, image) => {
        if (image) {
          snapshot = image
        }
      }
    })
    await writeKitty(first.terminal, 'a=T,f=100,i=7,U=1,c=2,r=2', PNG)
    first.terminal.dispose()
    const read = vi
      .fn(async () => snapshot)
      .mockImplementationOnce(async () => {
        if (failure === 'rejected') {
          throw new Error('temporary cache failure')
        }
        if (failure === 'absent') {
          return undefined
        }
        return {
          ...snapshot,
          image: {
            ...snapshot.image,
            ...(failure === 'wrong id'
              ? { id: 8 }
              : { data: new Blob([new Uint8Array(9 * 1024 * 1024)]) })
          }
        }
      })
    const h = createPlaceholderTerminal({ readKittyImage: read })
    try {
      await write(h.terminal, placeholderCells(7))
      for (let frame = 0; frame < 5; frame++) {
        render(h)
        await new Promise((resolve) => setTimeout(resolve, 0))
      }
      expect(read).toHaveBeenCalledTimes(1)
      expect(h.kitty.getImage(7)).toBeUndefined()
      await write(h.terminal, '\r')
      render(h)
      await vi.waitFor(() => expect(h.kitty.getImage(7)).toBeDefined())
      expect(read).toHaveBeenCalledTimes(2)
    } finally {
      h.terminal.dispose()
    }
  }
)

it('bounds recovery when visible prototypes exceed the decoded-pixel budget', async () => {
  const h = createPlaceholderTerminal()
  try {
    h.storage._pixelLimit = 200
    for (const id of [7, 8, 9]) {
      await writeKitty(h.terminal, `a=T,f=100,i=${id},U=1,c=2,r=2`, PNG)
    }
    await write(
      h.terminal,
      `${placeholderCells(7)}\r\n${placeholderCells(8)}\r\n${placeholderCells(9)}`
    )
    for (let frame = 0; frame < 20; frame++) {
      render(h)
      await new Promise((resolve) => setTimeout(resolve, 0))
    }
    expect(h.bitmaps.length).toBeLessThanOrEqual(6)
    expect(h.storage.getUsage()).toBeLessThanOrEqual(0.0008)
  } finally {
    h.terminal.dispose()
  }
})

it('bounds replay reads when visible payloads exceed the encoded-byte budget', async () => {
  const saved = new Map()
  const first = createPlaceholderTerminal({
    onKittyImageChanged: (id, image) => {
      if (image) {
        saved.set(id, image)
      }
    }
  })
  for (const id of [7, 8]) {
    await writeKitty(first.terminal, `a=T,f=100,i=${id},U=1,c=2,r=2`, PNG)
  }
  first.terminal.dispose()
  const read = vi.fn(async (id) => saved.get(id))
  const second = createPlaceholderTerminal({ readKittyImage: read })
  try {
    vi.spyOn(second.storage, 'getLimit').mockReturnValue(saved.get(7).image.data.size / 1000000)
    await write(second.terminal, `${placeholderCells(7)}\r\n${placeholderCells(8)}`)
    for (let frame = 0; frame < 20; frame++) {
      render(second)
      await new Promise((resolve) => setTimeout(resolve, 0))
    }
    expect(read).toHaveBeenCalledTimes(2)
    expect(second.kitty.images.size).toBeLessThanOrEqual(1)
  } finally {
    second.terminal.dispose()
  }
})
