/** The registry's lifetime on a mount: one per session, and swept when either one ends. */
import type { ReactElement } from 'react'
import { act, create } from 'react-test-renderer'
import { describe, expect, it } from 'vitest'
import { MediaHandleRegistry } from './media-handle-registry'
import { useMediaHandleRegistry } from './use-media-handle-registry'

const STAGED = { uri: 'file:///cache/a.png', mime: 'image/png', byteLength: 12 }

function harness(): {
  render: (sessionId: string | null) => void
  unmount: () => void
  readonly discarded: string[]
  readonly seen: MediaHandleRegistry[]
} {
  const discarded: string[] = []
  const seen: MediaHandleRegistry[] = []

  function Probe({ sessionId }: { sessionId: string | null }): ReactElement | null {
    const registry = useMediaHandleRegistry({
      sessionId,
      discard: (uri) => discarded.push(uri)
    })
    if (seen.at(-1) !== registry) {
      seen.push(registry)
    }
    return null
  }

  let tree: ReturnType<typeof create> | null = null
  return {
    render(sessionId) {
      act(() => {
        if (tree === null) {
          tree = create(<Probe sessionId={sessionId} />)
        } else {
          tree.update(<Probe sessionId={sessionId} />)
        }
      })
    },
    unmount() {
      act(() => {
        tree?.unmount()
      })
    },
    discarded,
    seen
  }
}

describe('the registry a mounted page session holds', () => {
  it('hands the same registry back across renders of one session', () => {
    const probe = harness()
    probe.render('session-a')
    probe.render('session-a')
    expect(probe.seen).toHaveLength(1)
  })

  it('releases every staged file when the page unmounts', () => {
    const probe = harness()
    probe.render('session-a')
    probe.seen[0]?.mint([STAGED, { ...STAGED, uri: 'file:///cache/b.png' }])
    expect(probe.discarded).toEqual([])
    probe.unmount()
    expect(probe.discarded).toEqual(['file:///cache/a.png', 'file:///cache/b.png'])
  })

  it('releases the old session s files when a new session takes the mount', () => {
    // A remount is a new session id, and the document behind the old one is gone: nothing will
    // ever call `release` for what it staged.
    const probe = harness()
    probe.render('session-a')
    probe.seen[0]?.mint([STAGED])
    probe.render('session-b')
    expect(probe.discarded).toEqual(['file:///cache/a.png'])
    expect(probe.seen).toHaveLength(2)
    expect(probe.seen[1]?.liveCount()).toBe(0)
  })

  it('gives a mount with no session a registry too, so a caller never holds null', () => {
    const probe = harness()
    probe.render(null)
    expect(probe.seen[0]).toBeInstanceOf(MediaHandleRegistry)
    probe.unmount()
    expect(probe.discarded).toEqual([])
  })
})
