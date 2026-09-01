import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
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

  // The attach is the answer the window was waiting for from that client; nothing later reopens it.
  it('closes for a client as soon as its host reconciles, well inside the window', () => {
    const window = new ClientHostedPageReconciliationWindow(OPENED_AT)
    window.markReconciled(DEVICE_A)

    expect(window.isUnreconciled(DEVICE_A, OPENED_AT + 1)).toBe(false)
    expect(window.isUnreconciled(DEVICE_A, OPENED_AT + WINDOW_MS / 2)).toBe(false)
  })

  // The two-client failure this keying exists for: one desktop attaching says nothing about the
  // pages another desktop is still hosting, and a shared latch let the second one cull live rows.
  it('keeps holding for a second client whose host has not attached yet', () => {
    const window = new ClientHostedPageReconciliationWindow(OPENED_AT)
    window.markReconciled(DEVICE_A)

    expect(window.isUnreconciled(DEVICE_B, OPENED_AT + 1)).toBe(true)

    window.markReconciled(DEVICE_B)

    expect(window.isUnreconciled(DEVICE_B, OPENED_AT + 2)).toBe(false)
    expect(window.isUnreconciled(DEVICE_A, OPENED_AT + 2)).toBe(false)
  })

  // A subscriber with no paired identity is nobody's host, so no attach can ever speak for it.
  it('never lets a named attach settle an unidentified subscriber', () => {
    const window = new ClientHostedPageReconciliationWindow(OPENED_AT)
    window.markReconciled(DEVICE_A)

    expect(window.isUnreconciled(undefined, OPENED_AT + 1)).toBe(true)
    expect(window.isUnreconciled('', OPENED_AT + 1)).toBe(true)
  })

  // Elapsed === windowMs is already expired: the check is a strict `<`.
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

  // This bound is what stops a host that never returns from holding client-hosted rows open forever.
  it('bounds the default hold at 45 seconds', () => {
    expect(DEFAULT_CLIENT_HOSTED_RECONCILIATION_WINDOW_MS).toBe(45_000)
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

  // One frame is built once and handed to every subscriber. Stamping without clearing would carry
  // an unreconciled client's hold onto the copy a reconciled client receives.
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

// The hold is only correct if every snapshot leaving the runtime for a client goes through the
// per-client seam. A `project` call that bypasses it publishes an unheld -- or another client's --
// answer, which is invisible to any behavioral test that does not happen to cover that call site.
describe('session-tabs projection census', () => {
  it('routes every client projection in orca-runtime through the per-client seam', () => {
    const source = readOrcaRuntimeSourceFamily()
    const direct = source.match(/this\.clientSessionTabSelections\.project\(/g) ?? []

    // Exactly two: inside `projectMobileSessionTabsForClient` itself, and the removed-worktree
    // frame, which announces a deletion the client asked for rather than answering about contents.
    expect(direct).toHaveLength(2)
    expect(source).toContain('this.clientSessionTabSelections.project(removed,')
  })

  it('keeps the unreconciled flag out of every other runtime publication site', () => {
    const source = readOrcaRuntimeSourceFamily()

    expect(source).not.toContain('clientHostedPagesUnreconciled')
  })
})

function readOrcaRuntimeSourceFamily(): string {
  return readdirSync(import.meta.dirname)
    .filter(
      (name) =>
        (name === 'orca-runtime.ts' || name.startsWith('orca-runtime-')) &&
        name.endsWith('.ts') &&
        !name.includes('.test.') &&
        !name.endsWith('-fixtures.ts') &&
        !name.endsWith('-test-harness.ts') &&
        !name.endsWith('-mock-registry.ts')
    )
    .sort()
    .map((name) => readFileSync(join(import.meta.dirname, name), 'utf8'))
    .join('\n')
}
