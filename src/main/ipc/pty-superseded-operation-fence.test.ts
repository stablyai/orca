/**
 * A mutating operation must not reach a PTY that has been superseded for its
 * pane. Main keeps `ptyPaneKey` and `paneKeyPtyId` in lock-step, so their
 * disagreement is proof the caller's id is stale — not an inference from
 * absence, which is why an id with no recorded pane stays permitted.
 *
 * The fence lives in the main process because the renderer queues input: a
 * keystroke buffered before a reattach would otherwise land on the successor.
 */
import { describe, expect, it } from 'vitest'

/** Mirrors the maps and predicate in pty.ts. Kept structural so the oracle
 *  tests the RULE, not one implementation of it. */
function makeFence() {
  const ptyPaneKey = new Map<string, string>()
  const paneKeyPtyId = new Map<string, string>()
  const bind = (paneKey: string, ptyId: string): void => {
    ptyPaneKey.set(ptyId, paneKey)
    paneKeyPtyId.set(paneKey, ptyId)
  }
  const isSuperseded = (ptyId: string): boolean => {
    const paneKey = ptyPaneKey.get(ptyId)
    if (paneKey === undefined) {
      return false
    }
    const currentPtyId = paneKeyPtyId.get(paneKey)
    return currentPtyId !== undefined && currentPtyId !== ptyId
  }
  return { bind, isSuperseded, ptyPaneKey, paneKeyPtyId }
}

const PANE = 'tab-1:3f1c9a2e-7b4d-4e1a-9c8f-2d5e6a7b8c90'

describe('superseded PTY operation fence', () => {
  it('refuses an operation whose pane has since bound a different PTY', () => {
    const fence = makeFence()
    fence.bind(PANE, 'pty-old')
    // The pane reattaches onto a fresh PTY; the renderer still holds pty-old.
    fence.bind(PANE, 'pty-new')

    expect(fence.isSuperseded('pty-old')).toBe(true)
    expect(fence.isSuperseded('pty-new')).toBe(false)
  })

  it('permits the current PTY for its own pane', () => {
    const fence = makeFence()
    fence.bind(PANE, 'pty-live')

    expect(fence.isSuperseded('pty-live')).toBe(false)
  })

  // Unknown is not stale. Orphan cleanup targets exactly these ids, so refusing
  // them would break the operation that reclaims leaked shells.
  it('permits a PTY that owns no pane', () => {
    const fence = makeFence()

    expect(fence.isSuperseded('pty-orphan')).toBe(false)
  })

  it('permits a PTY whose pane record was dropped', () => {
    const fence = makeFence()
    fence.bind(PANE, 'pty-live')
    fence.paneKeyPtyId.delete(PANE)

    expect(fence.isSuperseded('pty-live')).toBe(false)
  })

  it('keeps sibling panes independent', () => {
    const fence = makeFence()
    const other = 'tab-1:8a2b4c6d-1e3f-4a5b-8c7d-9e0f1a2b3c4d'
    fence.bind(PANE, 'pty-a')
    fence.bind(other, 'pty-b')
    fence.bind(PANE, 'pty-a2')

    expect(fence.isSuperseded('pty-a')).toBe(true)
    expect(fence.isSuperseded('pty-b')).toBe(false)
  })
})

describe('the fence is wired into every mutating handler', () => {
  it('combines supersession and incarnation in the write fence', async () => {
    const { readFileSync } = await import('node:fs')
    const source = readFileSync('src/main/ipc/pty.ts', 'utf-8')
    const start = source.indexOf('const isCurrentPtyWrite')

    expect(start).toBeGreaterThan(0)
    expect(source.slice(start, start + 300)).toContain('isSupersededPtyId')
    expect(source.slice(start, start + 300)).toContain('ptyIncarnationById')
  })

  // The capability existed for months and was never called from these handlers.
  // Pin the call site, not the capability — that is the failure this program hit.
  it.each(['pty:write', 'pty:writeAccepted', 'pty:resize', 'pty:signal'])(
    '%s consults the fence',
    async (channel) => {
      const { readFileSync } = await import('node:fs')
      const source = readFileSync('src/main/ipc/pty.ts', 'utf-8')
      // Anchor on the registration, not the first mention of the name.
      const start = source.search(
        new RegExp(`ipcMain\\.(?:on|handle)\\(\\s*'${channel.replace(':', ':')}'`)
      )
      expect(start, `${channel} handler not found`).toBeGreaterThan(0)
      expect(source.slice(start, start + 700)).toContain(
        channel.startsWith('pty:write') ? 'isCurrentPtyWrite' : 'isSupersededPtyId'
      )
    }
  )

  // pty:kill is deliberately NOT fenced: a superseded PTY is orphaned, and
  // reclaiming it is exactly what the orphan-cleanup callers ask for.
  it('leaves pty:kill unfenced on purpose', async () => {
    const { readFileSync } = await import('node:fs')
    const source = readFileSync('src/main/ipc/pty.ts', 'utf-8')
    const start = source.search(/ipcMain\.handle\(\s*'pty:kill'/)
    expect(start).toBeGreaterThan(0)
    expect(source.slice(start, start + 500)).not.toContain('isSupersededPtyId')
  })
})
