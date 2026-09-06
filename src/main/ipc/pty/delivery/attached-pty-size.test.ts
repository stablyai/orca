import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  commitAttachedPtySize,
  resolveCommittedPtySize,
  shouldSeedPreAttachPtySize
} from './attached-pty-size'
import { ptySizes } from './visibility-state'

const REQUESTED = { cols: 80, rows: 24 }
const CACHED = { cols: 180, rows: 50 }
const LIVE = { cols: 211, rows: 57 }

describe('shouldSeedPreAttachPtySize', () => {
  it('seeds a fresh session id even when the pane never measured itself', () => {
    expect(
      shouldSeedPreAttachPtySize({
        isFreshSessionId: true,
        hasCachedSize: true,
        requestIsUnmeasured: true
      })
    ).toBe(true)
  })

  it('never overwrites a size main already holds for the session', () => {
    expect(
      shouldSeedPreAttachPtySize({
        isFreshSessionId: false,
        hasCachedSize: true,
        requestIsUnmeasured: false
      })
    ).toBe(false)
  })

  it('refuses an unmeasured request on an attach even with nothing cached', () => {
    expect(
      shouldSeedPreAttachPtySize({
        isFreshSessionId: false,
        hasCachedSize: false,
        requestIsUnmeasured: true
      })
    ).toBe(false)
  })

  it('seeds a measured attach request when main holds nothing better', () => {
    expect(
      shouldSeedPreAttachPtySize({
        isFreshSessionId: false,
        hasCachedSize: false,
        requestIsUnmeasured: false
      })
    ).toBe(true)
  })
})

describe('resolveCommittedPtySize', () => {
  it('records the requested grid for a fresh spawn, ignoring any stale cache', () => {
    expect(
      resolveCommittedPtySize({
        result: {},
        requested: REQUESTED,
        cachedBeforeAttach: CACHED
      })
    ).toEqual(REQUESTED)
  })

  it('prefers a grid the provider applied on attach', () => {
    expect(
      resolveCommittedPtySize({
        result: {
          isReattach: true,
          attachedGrid: { cols: 100, rows: 30 },
          snapshotCols: LIVE.cols,
          snapshotRows: LIVE.rows
        },
        requested: REQUESTED,
        cachedBeforeAttach: CACHED
      })
    ).toEqual({ cols: 100, rows: 30 })
  })

  it('falls back to the reattach snapshot grid', () => {
    expect(
      resolveCommittedPtySize({
        result: { isReattach: true, snapshotCols: LIVE.cols, snapshotRows: LIVE.rows },
        requested: REQUESTED,
        cachedBeforeAttach: CACHED
      })
    ).toEqual(LIVE)
  })

  it('falls back to the size main held when the provider proves nothing', () => {
    expect(
      resolveCommittedPtySize({
        result: { isReattach: true },
        requested: REQUESTED,
        cachedBeforeAttach: CACHED
      })
    ).toEqual(CACHED)
  })

  it('rejects a non-integer provider grid as unproven', () => {
    expect(
      resolveCommittedPtySize({
        result: { isReattach: true, snapshotCols: 120.5, snapshotRows: 40 },
        requested: REQUESTED,
        cachedBeforeAttach: CACHED
      })
    ).toEqual(CACHED)
  })

  it('takes the request only when nothing better exists', () => {
    expect(
      resolveCommittedPtySize({
        result: { isReattach: true },
        requested: REQUESTED,
        cachedBeforeAttach: undefined
      })
    ).toEqual(REQUESTED)
  })

  it('rejects a non-positive provider grid rather than publishing a zero-width model', () => {
    expect(
      resolveCommittedPtySize({
        result: { isReattach: true, snapshotCols: 0, snapshotRows: 0 },
        requested: REQUESTED,
        cachedBeforeAttach: CACHED
      })
    ).toEqual(CACHED)
  })
})

describe('commitAttachedPtySize', () => {
  afterEach(() => {
    ptySizes.delete('pty-commit')
  })

  it('records the resolved grid and reflows the model onto it for a reattach', () => {
    const reflow = vi.fn()
    const committed = commitAttachedPtySize({
      result: {
        id: 'pty-commit',
        isReattach: true,
        snapshotCols: LIVE.cols,
        snapshotRows: LIVE.rows
      },
      requested: REQUESTED,
      cachedBeforeAttach: undefined,
      reflowHeadlessTerminalToPtyGrid: reflow
    })
    expect(committed).toEqual(LIVE)
    expect(ptySizes.get('pty-commit')).toEqual(LIVE)
    expect(reflow).toHaveBeenCalledWith('pty-commit', LIVE.cols, LIVE.rows)
  })

  it('reflows a fresh spawn onto the request too: bytes can create the model before the reply', () => {
    const reflow = vi.fn()
    commitAttachedPtySize({
      result: { id: 'pty-commit' },
      requested: REQUESTED,
      cachedBeforeAttach: CACHED,
      reflowHeadlessTerminalToPtyGrid: reflow
    })
    expect(ptySizes.get('pty-commit')).toEqual(REQUESTED)
    expect(reflow).toHaveBeenCalledWith('pty-commit', REQUESTED.cols, REQUESTED.rows)
  })
})
