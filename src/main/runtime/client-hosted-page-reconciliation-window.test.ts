import { describe, expect, it } from 'vitest'
import {
  ClientHostedPageReconciliationWindow,
  DEFAULT_CLIENT_HOSTED_RECONCILIATION_WINDOW_MS
} from './client-hosted-page-reconciliation-window'

const OPENED_AT = 1_700_000_000_000
const WINDOW_MS = DEFAULT_CLIENT_HOSTED_RECONCILIATION_WINDOW_MS
const DEVICE_A = 'device-a'
const DEVICE_B = 'device-b'

describe('ClientHostedPageReconciliationWindow', () => {
  it('reports unreconciled the instant it opens', () => {
    const window = new ClientHostedPageReconciliationWindow(OPENED_AT)

    expect(window.isUnreconciled(DEVICE_A, OPENED_AT)).toBe(true)
  })

  it('reports unreconciled part-way through the window', () => {
    const window = new ClientHostedPageReconciliationWindow(OPENED_AT)

    expect(window.isUnreconciled(DEVICE_A, OPENED_AT + WINDOW_MS / 2)).toBe(true)
  })

  it('closes for a client as soon as its host reconciles, well inside the window', () => {
    const window = new ClientHostedPageReconciliationWindow(OPENED_AT)
    window.markReconciled(DEVICE_A)

    expect(window.isUnreconciled(DEVICE_A, OPENED_AT + 1)).toBe(false)
    expect(window.isUnreconciled(DEVICE_A, OPENED_AT + WINDOW_MS / 2)).toBe(false)
  })

  // A shared latch could let the second client cull live rows before its own host attaches.
  it('keeps holding for a second client whose host has not attached yet', () => {
    const window = new ClientHostedPageReconciliationWindow(OPENED_AT)
    window.markReconciled(DEVICE_A)

    expect(window.isUnreconciled(DEVICE_B, OPENED_AT + 1)).toBe(true)

    window.markReconciled(DEVICE_B)

    expect(window.isUnreconciled(DEVICE_B, OPENED_AT + 2)).toBe(false)
    expect(window.isUnreconciled(DEVICE_A, OPENED_AT + 2)).toBe(false)
  })

  it('never lets a named attach settle an unidentified subscriber', () => {
    const window = new ClientHostedPageReconciliationWindow(OPENED_AT)
    window.markReconciled(DEVICE_A)

    expect(window.isUnreconciled(undefined, OPENED_AT + 1)).toBe(true)
    expect(window.isUnreconciled('', OPENED_AT + 1)).toBe(true)
  })

  it('closes at the exact deadline and beyond when no host ever attaches', () => {
    const window = new ClientHostedPageReconciliationWindow(OPENED_AT)

    expect(window.isUnreconciled(DEVICE_A, OPENED_AT + WINDOW_MS - 1)).toBe(true)
    expect(window.isUnreconciled(DEVICE_A, OPENED_AT + WINDOW_MS)).toBe(false)
    expect(window.isUnreconciled(DEVICE_B, OPENED_AT + WINDOW_MS + 10_000)).toBe(false)
  })

  it('stays reconciled across repeated marks and later queries', () => {
    const window = new ClientHostedPageReconciliationWindow(OPENED_AT)
    window.markReconciled(DEVICE_A)
    window.markReconciled(DEVICE_A)

    expect(window.isUnreconciled(DEVICE_A, OPENED_AT)).toBe(false)
    expect(window.isUnreconciled(DEVICE_A, OPENED_AT + WINDOW_MS * 2)).toBe(false)
  })

  it('honors a custom window length rather than the default bound', () => {
    const window = new ClientHostedPageReconciliationWindow(OPENED_AT, 100)

    expect(window.isUnreconciled(DEVICE_A, OPENED_AT + 99)).toBe(true)
    expect(window.isUnreconciled(DEVICE_A, OPENED_AT + 100)).toBe(false)
  })
})

describe('holdFor', () => {
  const frame: { worktree: string; snapshotVersion: number; clientHostedPagesUnreconciled?: true } =
    { worktree: 'wt-a', snapshotVersion: 3 }

  it('stamps the hold onto a frame bound for an unreconciled client', () => {
    const window = new ClientHostedPageReconciliationWindow(OPENED_AT)

    expect(window.holdFor(frame, DEVICE_A, OPENED_AT)).toEqual({
      ...frame,
      clientHostedPagesUnreconciled: true
    })
  })

  it('leaves a frame unstamped once that client has reconciled', () => {
    const window = new ClientHostedPageReconciliationWindow(OPENED_AT)
    window.markReconciled(DEVICE_A)

    const held = window.holdFor(frame, DEVICE_A, OPENED_AT)

    expect(held).toBe(frame)
    expect(held).not.toHaveProperty('clientHostedPagesUnreconciled')
  })

  // Frames fan out to every subscriber; clear the previous client's hold as well as setting it.
  it('clears a hold another client stamped on the same frame', () => {
    const window = new ClientHostedPageReconciliationWindow(OPENED_AT)
    window.markReconciled(DEVICE_B)
    const stamped = window.holdFor(frame, DEVICE_A, OPENED_AT)

    expect(window.holdFor(stamped, DEVICE_B, OPENED_AT)).toEqual(frame)
  })

  it('clears the hold once the deadline passes even with no attach', () => {
    const window = new ClientHostedPageReconciliationWindow(OPENED_AT)
    const stamped = window.holdFor(frame, DEVICE_A, OPENED_AT)

    expect(window.holdFor(stamped, DEVICE_A, OPENED_AT + WINDOW_MS)).toEqual(frame)
  })
})
