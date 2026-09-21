// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { mountTerminalWebDocument } from './terminal-web-document-mount'

/**
 * One live document per page, and the undo that frees the page for the next one.
 *
 * `document-scope` is a module singleton: every module in `document/` reads that one object, so
 * two mounts at once would not be two terminals but two drivers of the same fields and the same
 * elements. The component cannot reach that state — it mounts and disposes in one effect — which
 * is why the refusal is named here rather than left to surface as two terminals overwriting each
 * other's surface. The second half is the one the page actually uses: dispose has to give the
 * page back, or a remount and the error overlay's Reload would both be refused.
 */
describe('the page terminal document', () => {
  beforeEach(() => {
    document.body.innerHTML = ''
    document.head.innerHTML = ''
  })

  it('refuses a second mount while one is live, and takes it back on dispose', async () => {
    const host = document.createElement('div')
    document.body.appendChild(host)
    const second = document.createElement('div')
    document.body.appendChild(second)

    const mounted = mountTerminalWebDocument(host, () => {})
    await mounted.ready
    expect(() => mountTerminalWebDocument(second, () => {})).toThrow(
      'the terminal document is already mounted on this page'
    )

    mounted.dispose()
    const remounted = mountTerminalWebDocument(second, () => {})
    await remounted.ready
    expect(second.querySelector('#terminal-container')).not.toBe(null)
    remounted.dispose()
  })

  it('disposes the terminal a swap left behind, not only the live one', async () => {
    // `beginTerminalSurfaceSwap` opens a hidden replacement and hands the committed terminal to
    // `commitTerminalSurfaceSwap`, which disposes it. An unmount between the two is the case this
    // covers: the committed terminal is nobody's, and a dispose that reached only `scope.term`
    // would leave it holding its renderer, its observers and its buffers for the life of the tab.
    const host = document.createElement('div')
    document.body.appendChild(host)
    const mounted = mountTerminalWebDocument(host, () => {})
    await mounted.ready
    const { scope } = await import('./document/page-document-modules')

    const disposed: string[] = []
    const fake = (name: string) => ({ dispose: () => disposed.push(name) })
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: dispose is the only member this case reaches, and the two doubles carry it.
    scope.committedTerm = fake('committed') as unknown as typeof scope.committedTerm
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: as above; the mount's dispose calls nothing else on either.
    scope.term = fake('live') as unknown as typeof scope.term

    mounted.dispose()
    expect(disposed.sort()).toEqual(['committed', 'live'])
    expect(scope.term).toBe(null)
    expect(scope.committedTerm).toBe(null)
  })

  it('disposes one terminal once when no swap is open', async () => {
    // The other half: with no swap in flight the two fields are the same object, and disposing it
    // twice is what the deduplication exists to stop.
    const host = document.createElement('div')
    document.body.appendChild(host)
    const mounted = mountTerminalWebDocument(host, () => {})
    await mounted.ready
    const { scope } = await import('./document/page-document-modules')

    let disposals = 0
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: dispose is the only member the mount's dispose reaches.
    const only = { dispose: () => (disposals += 1) } as unknown as typeof scope.term
    scope.term = only
    scope.committedTerm = only

    mounted.dispose()
    expect(disposals).toBe(1)
  })

  it('tears down once, however many times the handle is disposed', async () => {
    // A handle outlives what it built: the component keeps one in a ref, and React may run a
    // cleanup twice. Everything dispose touches is shared, so what a second run would reach is
    // whatever owns the scope by then — stood in for here by a terminal put back after the first
    // dispose, which is what the next mount does.
    const host = document.createElement('div')
    document.body.appendChild(host)
    const mounted = mountTerminalWebDocument(host, () => {})
    await mounted.ready
    const { scope } = await import('./document/page-document-modules')

    mounted.dispose()

    let disposals = 0
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: dispose is the only member the mount's dispose reaches on a terminal.
    scope.term = { dispose: () => (disposals += 1) } as unknown as typeof scope.term

    mounted.dispose()
    mounted.dispose()
    expect(disposals).toBe(0)
    expect(scope.term).not.toBe(null)
  })

  it('does nothing when a stale handle is disposed after another document mounted', async () => {
    // The case the idempotence check alone would miss. The first handle is spent, a second
    // document is up, and the first handle's dispose arrives late — from a ref, from a cleanup
    // React deferred. Comparing a token rather than the host or its class is what makes this
    // answerable: the two mounts can be handed the same element.
    const first = document.createElement('div')
    const second = document.createElement('div')
    document.body.append(first, second)

    const stale = mountTerminalWebDocument(first, () => {})
    await stale.ready
    stale.dispose()
    const live = mountTerminalWebDocument(second, () => {})
    await live.ready
    const { scope } = await import('./document/page-document-modules')

    let disposals = 0
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: as above; the live document's terminal is only ever disposed here.
    scope.term = { dispose: () => (disposals += 1) } as unknown as typeof scope.term

    stale.dispose()

    expect(disposals).toBe(0)
    expect(second.querySelector('#terminal-container')).not.toBe(null)
    expect(scope.term).not.toBe(null)
    // And the page is still taken, so the live document is still the one that owns it.
    expect(() => mountTerminalWebDocument(first, () => {})).toThrow(
      'the terminal document is already mounted on this page'
    )
    live.dispose()
  })

  it('tells two mounts of the same element apart, which a host comparison cannot', async () => {
    // Why the claim is a token and not the host. React reuses elements, so the page can hand the
    // second mount the very element the first one used — that is the ordinary remount, not a
    // corner. A dispose that asked "is this my host?" would answer yes for both handles, and the
    // stale one would tear down the live document while leaving the page claimed.
    const host = document.createElement('div')
    document.body.appendChild(host)

    const stale = mountTerminalWebDocument(host, () => {})
    await stale.ready
    stale.dispose()
    const live = mountTerminalWebDocument(host, () => {})
    await live.ready
    const { scope } = await import('./document/page-document-modules')

    let disposals = 0
    // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: dispose is the only member the mount's dispose reaches on a terminal.
    scope.term = { dispose: () => (disposals += 1) } as unknown as typeof scope.term

    stale.dispose()

    expect(disposals).toBe(0)
    expect(host.querySelector('#terminal-container')).not.toBe(null)
    expect(host.classList.contains('orca-terminal-document-host')).toBe(true)
    expect(() => mountTerminalWebDocument(host, () => {})).toThrow(
      'the terminal document is already mounted on this page'
    )
    live.dispose()
  })

  it('touches nothing when it is disposed before its chunk lands', async () => {
    // The window the synchronous handle opened. `dispose` can now run while the import is still
    // unresolved, so the build resumes on a page it no longer owns — and everything after its
    // await writes shared state: the six seams are fields on one module scope, and
    // `startPageDocumentModules` resets that scope and installs the document's listeners. A mount
    // that checked only when it resolved would have done all of that first and then discarded the
    // result, leaving the listeners behind and a later mount's scope reset out from under it.
    const host = document.createElement('div')
    document.body.appendChild(host)
    const { scope } = await import('./document/page-document-modules')
    const seamsBefore = {
      postToHost: scope.postToHost,
      installErrorReporter: scope.installErrorReporter,
      paintDocumentBackground: scope.paintDocumentBackground,
      createTerminal: scope.createTerminal,
      createUnicode11Addon: scope.createUnicode11Addon,
      createWebglAddon: scope.createWebglAddon
    }
    const generationBefore = scope.terminalGeneration

    const mounted = mountTerminalWebDocument(host, () => {})
    mounted.dispose()
    // Armed after the dispose, so anything they catch is the resuming build and nothing else.
    const listeners = vi.spyOn(EventTarget.prototype, 'addEventListener')
    const timers = vi.spyOn(globalThis, 'setTimeout')
    const frames = vi.spyOn(globalThis, 'requestAnimationFrame')
    try {
      // Resolves: the caller asked for the terminal and then asked for it to go away, so the
      // chunk landing afterwards is not a failure to report to the error overlay.
      await expect(mounted.ready).resolves.toBeUndefined()
    } finally {
      listeners.mockRestore()
      timers.mockRestore()
      frames.mockRestore()
    }

    expect(listeners).not.toHaveBeenCalled()
    expect(timers).not.toHaveBeenCalled()
    expect(frames).not.toHaveBeenCalled()
    expect({
      postToHost: scope.postToHost,
      installErrorReporter: scope.installErrorReporter,
      paintDocumentBackground: scope.paintDocumentBackground,
      createTerminal: scope.createTerminal,
      createUnicode11Addon: scope.createUnicode11Addon,
      createWebglAddon: scope.createWebglAddon
    }).toEqual(seamsBefore)
    // `startPageDocumentModules` resets the scope, which carries this forward by one. Unchanged
    // is the start sequence never having run.
    expect(scope.terminalGeneration).toBe(generationBefore)
    // And the page is free, which is what the overlay's Reload needs.
    const remounted = mountTerminalWebDocument(host, () => {})
    await remounted.ready
    expect(host.querySelector('#terminal-container')).not.toBe(null)
    remounted.dispose()
  })

  it('tears down a document that started, however late the dispose is', async () => {
    // The start sequence and the handle on what undoes it have to land in one turn. They did not:
    // the build started the document, installed its listeners and returned, and the assignment
    // that recorded it ran a microtask later — so a dispose in between found nothing started,
    // skipped the teardown and handed the page back with the document still running on it. The
    // dispose here is queued behind the document module import the build awaits, which puts it in
    // that window rather than before or after it.
    const host = document.createElement('div')
    document.body.appendChild(host)
    const listeners = new Set<unknown>()
    let adds = 0
    const realAdd = window.addEventListener.bind(window)
    const realRemove = window.removeEventListener.bind(window)
    // Parameters taken from the bound original, so the wrapper carries the real signature rather
    // than three implicit `any`s the tests typecheck refuses.
    window.addEventListener = (...added: Parameters<typeof realAdd>) => {
      if (added[0] === 'resize') {
        adds += 1
        listeners.add(added[1])
      }
      realAdd(...added)
    }
    window.removeEventListener = (...removed: Parameters<typeof realRemove>) => {
      if (removed[0] === 'resize') {
        listeners.delete(removed[1])
      }
      realRemove(...removed)
    }

    const mounted = mountTerminalWebDocument(host, () => {})
    try {
      await import('./document/page-document-modules')
      mounted.dispose()
      await mounted.ready
    } finally {
      window.addEventListener = realAdd
      window.removeEventListener = realRemove
    }

    // The precondition: the document did start, so there was something to tear down. A build that
    // returned right after its ownership check would add nothing and satisfy the emptiness below
    // for the one reason this case exists to refuse. Counted on the way in rather than read off
    // the host afterwards — dispose empties the host on every path, so that told us nothing.
    expect(adds, 'the document started and added its resize listener').toBe(1)
    expect(listeners.size, 'the resize listener the started document added').toBe(0)
    const { scope } = await import('./document/page-document-modules')
    expect(scope.term).toBe(null)
    // And the page is free, which a handle that lost track of what it started would not have left.
    const remounted = mountTerminalWebDocument(host, () => {})
    await remounted.ready
    remounted.dispose()
  })

  it('routes nothing into the document that replaced it', async () => {
    // `send` reads what the mount adopted, and what it adopted names the page's one set of
    // document modules. A handle that kept them after its dispose would hand a host command to
    // whichever document is live next: same modules, same scope, a terminal that is not its own.
    // `ping` is the cheapest way to see it, because the document answers it by posting through the
    // scope's `postToHost` seam — which by then belongs to the mount that replaced this one.
    const host = document.createElement('div')
    document.body.appendChild(host)
    const stale = mountTerminalWebDocument(host, () => {})
    await stale.ready
    stale.dispose()

    const posts: unknown[] = []
    const live = mountTerminalWebDocument(host, (message) => posts.push(message.type))
    await live.ready
    stale.send({ id: 4242, type: 'ping' })
    expect(posts).toEqual([])

    // The precondition: the live document does answer a ping, so the silence above is the stale
    // handle declining to speak rather than the command doing nothing.
    live.send({ id: 4243, type: 'ping' })
    expect(posts).toEqual(['pong'])
    live.dispose()
  })

  it('gives the page back when the mount itself fails, so Reload can try again', async () => {
    // The overlay's Reload path. A mount that threw holds nothing, and a flag left set would
    // refuse every later attempt — the document's chunk failing to load is exactly that case.
    const detached = document.createElement('div')
    Object.defineProperty(detached, 'innerHTML', {
      set() {
        throw new Error('orca-mount-failed')
      },
      get() {
        return ''
      }
    })
    expect(() => mountTerminalWebDocument(detached, () => {})).toThrow('orca-mount-failed')

    const host = document.createElement('div')
    document.body.appendChild(host)
    const mounted = mountTerminalWebDocument(host, () => {})
    await mounted.ready
    expect(host.querySelector('#terminal-container')).not.toBe(null)
    mounted.dispose()
  })
})
