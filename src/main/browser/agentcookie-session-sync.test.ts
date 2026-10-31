import { afterEach, describe, expect, it, vi } from 'vitest'
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

vi.mock('./cookies/browser-cookie-import', () => ({
  importCookiesFromJson: vi.fn()
}))

const { diag } = vi.hoisted(() => ({ diag: vi.fn() }))
vi.mock('./cookies/browser-cookie-import-diagnostics', () => ({
  diag,
  summarizeCookieImportError: (value: unknown) => String(value).trim()
}))

import {
  AgentcookieSessionSync,
  pullAgentcookieSession,
  resolveApprovedAgentcookie
} from './agentcookie-session-sync'

function writeFakeAgentcookie(dir: string): string {
  const exe = join(dir, 'approved-agentcookie')
  writeFileSync(exe, '#!/bin/sh\necho "[]"\n')
  chmodSync(exe, 0o755)
  return exe
}

describe('resolveApprovedAgentcookie', () => {
  let dir: string
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('accepts only an absolute path to an existing executable', () => {
    dir = mkdtempSync(join(tmpdir(), 'ac-resolve-'))
    const exe = writeFakeAgentcookie(dir)
    expect(resolveApprovedAgentcookie(exe)).toBe(exe)
    expect(resolveApprovedAgentcookie(join(dir, 'missing'))).toBeNull()
    expect(resolveApprovedAgentcookie('approved-agentcookie')).toBeNull()
    expect(resolveApprovedAgentcookie(null)).toBeNull()
  })
})

describe('pullAgentcookieSession', () => {
  it('is a no-op (null) without a binary', async () => {
    expect(await pullAgentcookieSession('persist:orca-browser', null)).toBeNull()
  })

  it.skipIf(process.platform === 'win32')('logs stderr when the export fails', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ac-pull-'))
    const exe = join(dir, 'approved-agentcookie')
    writeFileSync(exe, '#!/bin/sh\necho "keychain denied" >&2\nexit 1\n')
    chmodSync(exe, 0o755)
    try {
      expect(await pullAgentcookieSession('persist:orca-browser', exe)).toBeNull()
      expect(diag).toHaveBeenCalledWith('agentcookie export failed: keychain denied')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('AgentcookieSessionSync', () => {
  it('never finds a binary on PATH when no path is approved', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ac-sync-'))
    const origPath = process.env.PATH
    process.env.PATH = dir
    writeFakeAgentcookie(dir)
    const onStatus = vi.fn()
    const sync = new AgentcookieSessionSync({
      targetPartition: 'persist:orca-browser',
      isEnabled: () => true,
      getApprovedBinaryPath: () => null,
      onStatus
    })
    const syncNow = vi.spyOn(sync, 'syncNow')
    try {
      sync.start()
      expect(onStatus).toHaveBeenCalledWith({
        detected: false,
        lastSyncAt: null,
        lastImportedCount: null
      })
      expect(syncNow).not.toHaveBeenCalled()
    } finally {
      sync.stop()
      process.env.PATH = origPath
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('stays idle while disabled and starts pulling once enabled', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ac-sync-'))
    const exe = writeFakeAgentcookie(dir)
    vi.useFakeTimers()
    try {
      let enabled = false
      const sync = new AgentcookieSessionSync({
        targetPartition: 'persist:orca-browser',
        isEnabled: () => enabled,
        getApprovedBinaryPath: () => exe,
        intervalMs: 1000
      })
      const syncNow = vi
        .spyOn(sync, 'syncNow')
        .mockResolvedValue({ detected: true, lastSyncAt: null, lastImportedCount: null })

      sync.start()
      vi.advanceTimersByTime(1000)
      expect(syncNow).not.toHaveBeenCalled()

      enabled = true
      vi.advanceTimersByTime(1000)
      expect(syncNow).toHaveBeenCalledTimes(1)
      sync.stop()
    } finally {
      vi.useRealTimers()
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('keeps one timer across repeated start() calls and can restart after stop()', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ac-sync-'))
    const exe = writeFakeAgentcookie(dir)
    vi.useFakeTimers()
    try {
      const sync = new AgentcookieSessionSync({
        targetPartition: 'persist:orca-browser',
        isEnabled: () => true,
        getApprovedBinaryPath: () => exe
      })
      const syncNow = vi
        .spyOn(sync, 'syncNow')
        .mockResolvedValue({ detected: true, lastSyncAt: null, lastImportedCount: null })

      sync.start()
      sync.start()
      expect(vi.getTimerCount()).toBe(1)
      expect(syncNow).toHaveBeenCalledTimes(1)

      sync.stop()
      expect(vi.getTimerCount()).toBe(0)

      sync.start()
      expect(vi.getTimerCount()).toBe(1)
      sync.stop()
    } finally {
      vi.useRealTimers()
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
