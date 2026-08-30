import { describe, expect, it } from 'vitest'
import { classifyLocalPtyChildProcesses, readLocalPtyTitle } from './local-pty-process-evidence'

const OBSERVED_SHELL = { verdict: 'observed', processName: 'zsh' } as const
const OBSERVED_AGENT = { verdict: 'observed', processName: 'codex' } as const
const UNVERIFIABLE = { verdict: 'unverifiable', reason: 'process table scan degraded' } as const

describe('readLocalPtyTitle', () => {
  it('reports a missing pty as unreadable', () => {
    expect(readLocalPtyTitle(undefined)).toEqual({ ok: false })
  })

  it('reports a thrown native title read as unreadable, not as a title', () => {
    const proc = {} as { process: string }
    Object.defineProperty(proc, 'process', {
      get() {
        throw new Error('native read failed')
      }
    })
    expect(readLocalPtyTitle(proc)).toEqual({ ok: false })
  })

  it('normalizes an empty title to null', () => {
    expect(readLocalPtyTitle({ process: '' })).toEqual({ ok: true, title: null })
  })
})

describe('classifyLocalPtyChildProcesses', () => {
  it('treats a reaped pty as positive absence', () => {
    expect(
      classifyLocalPtyChildProcesses({
        procPresent: false,
        titleRead: { ok: false },
        shell: 'zsh',
        foreground: OBSERVED_SHELL
      })
    ).toEqual({ hasChildProcesses: false, evidence: { verdict: 'exited' } })
  })

  it('keeps the legacy false collapse but reports a failed title read as unverifiable', () => {
    expect(
      classifyLocalPtyChildProcesses({
        procPresent: true,
        titleRead: { ok: false },
        shell: 'zsh',
        foreground: OBSERVED_SHELL
      })
    ).toEqual({
      hasChildProcesses: false,
      evidence: { verdict: 'unverifiable', reason: 'pty title read failed' }
    })
  })

  it('stays live when no shell was recorded', () => {
    expect(
      classifyLocalPtyChildProcesses({
        procPresent: true,
        titleRead: { ok: true, title: 'zsh' },
        shell: undefined,
        foreground: OBSERVED_SHELL
      })
    ).toEqual({ hasChildProcesses: true, evidence: { verdict: 'live' } })
  })

  it('reports live when the title differs from the shell', () => {
    expect(
      classifyLocalPtyChildProcesses({
        procPresent: true,
        titleRead: { ok: true, title: 'node' },
        shell: 'zsh',
        foreground: OBSERVED_AGENT
      })
    ).toEqual({ hasChildProcesses: true, evidence: { verdict: 'live' } })
  })

  it('only reads a shell title as exited when the foreground scan completed', () => {
    expect(
      classifyLocalPtyChildProcesses({
        procPresent: true,
        titleRead: { ok: true, title: 'zsh' },
        shell: 'zsh',
        foreground: OBSERVED_SHELL
      })
    ).toEqual({ hasChildProcesses: false, evidence: { verdict: 'exited' } })
  })

  it('reads a completed scan that observed nothing as positive absence', () => {
    // The canonical completion input: the agent exited, the scan ran to
    // completion and resolved no foreground process, and node-pty's title is
    // back to the shell. `processName: null` is the observation, not an
    // absent one, so this is the one shape that may say exited.
    expect(
      classifyLocalPtyChildProcesses({
        procPresent: true,
        titleRead: { ok: true, title: 'zsh' },
        shell: 'zsh',
        foreground: { verdict: 'observed', processName: null }
      })
    ).toEqual({ hasChildProcesses: false, evidence: { verdict: 'exited' } })
  })

  it('reads a shell title under a degraded scan as unverifiable', () => {
    // node-pty's POSIX title read silently falls back to the spawned shell
    // when the native read fails, so under scan distress "title == shell"
    // observes nothing.
    expect(
      classifyLocalPtyChildProcesses({
        procPresent: true,
        titleRead: { ok: true, title: 'zsh' },
        shell: 'zsh',
        foreground: UNVERIFIABLE
      })
    ).toEqual({
      hasChildProcesses: false,
      evidence: {
        verdict: 'unverifiable',
        reason: 'pty title matches the shell while the foreground scan is degraded'
      }
    })
  })

  it('lets a completed scan observing a non-shell foreground outrank a stale shell title', () => {
    expect(
      classifyLocalPtyChildProcesses({
        procPresent: true,
        titleRead: { ok: true, title: 'zsh' },
        shell: 'zsh',
        foreground: OBSERVED_AGENT
      })
    ).toEqual({ hasChildProcesses: false, evidence: { verdict: 'live' } })
  })
})
