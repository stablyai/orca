import { describe, expect, it } from 'vitest'
import {
  MAX_MOBILE_CRASH_DIAGNOSTICS_CHARS,
  MOBILE_CRASH_SESSION_STORAGE_KEY,
  MobileCrashSessionJournal,
  type MobileCrashStorage
} from './mobile-crash-session'

class MemoryStorage implements MobileCrashStorage {
  values = new Map<string, string>()

  async getItem(key: string): Promise<string | null> {
    return this.values.get(key) ?? null
  }

  async setItem(key: string, value: string): Promise<void> {
    this.values.set(key, value)
  }
}

const FIRST_SESSION_AT = Date.UTC(2026, 7, 24, 18, 0, 0)
const SECOND_SESSION_AT = FIRST_SESSION_AT + 30_000

describe('mobile crash session journal', () => {
  it('surfaces durable breadcrumbs after a simulated abnormal termination', async () => {
    const storage = new MemoryStorage()
    const first = new MobileCrashSessionJournal(storage, { now: () => FIRST_SESSION_AT })

    await first.start()
    await first.recordRoute(['h', 'private-host-id', 'session', 'private-worktree-id'])
    await first.recordRenderError(
      new Error('prompt contents from /Users/example/private-repo secret=do-not-store'),
      '\n    at PrivateScreen (/Users/example/private-repo/screen.tsx:1:1)'
    )
    // No background transition: the first process disappears with its marker open.

    const second = new MobileCrashSessionJournal(storage, { now: () => SECOND_SESSION_AT })
    const previous = await second.start()
    const report = await second.buildReport({ version: '0.0.29', platform: 'ios 26.5' })
    const persisted = storage.values.get(MOBILE_CRASH_SESSION_STORAGE_KEY) ?? ''

    expect(previous?.breadcrumbs.map((breadcrumb) => breadcrumb.name)).toEqual([
      'session_started',
      'route_changed',
      'render_error_contained'
    ])
    expect(previous?.endedAbnormally).toBe(true)
    expect(report).toContain('Previous session ended abnormally')
    expect(report).toContain('h > [dynamic] > session > [dynamic]')
    expect(report).toContain('errorFingerprint')
    expect(report).toContain('prompt contents from [redacted-path] secret=[redacted]')
    expect(report).not.toContain('private-host-id')
    expect(report).not.toContain('private-worktree-id')
    expect(report).not.toContain('do-not-store')
    expect(report).not.toContain('/Users/example/private-repo')
    expect(persisted).not.toContain('private-host-id')
    expect(persisted).not.toContain('private-worktree-id')
    expect(persisted).toContain('prompt contents from [redacted-path] secret=[redacted]')
    expect(persisted).not.toContain('do-not-store')
    expect(persisted).not.toContain('/Users/example/private-repo')
    expect(persisted.length).toBeLessThanOrEqual(MAX_MOBILE_CRASH_DIAGNOSTICS_CHARS)
    expect(JSON.parse(persisted).activeSession).not.toHaveProperty('id')
  })

  it('sanitizes every line of a multi-line error message before persistence and reporting', async () => {
    const storage = new MemoryStorage()
    const journal = new MobileCrashSessionJournal(storage, { now: () => FIRST_SESSION_AT })
    const error = new Error(
      [
        'Failed to render prompt: SECRET_TOKEN=first-secret',
        'Details in /Users/example/private-repo/first.ts token=second-secret',
        'Credentials alice:super-secret@example.com and /tmp/second-secret secret=third-secret'
      ].join('\n')
    )

    await journal.start()
    await journal.recordRenderError(error)

    const report = await journal.buildReport({ version: '0.0.29', platform: 'ios 26.5' })
    const persisted = storage.values.get(MOBILE_CRASH_SESSION_STORAGE_KEY) ?? ''
    for (const privateValue of [
      'first-secret',
      '/Users/example/private-repo/first.ts',
      'second-secret',
      'alice:super-secret@',
      '/tmp/second-secret',
      'third-secret'
    ]) {
      expect(report).not.toContain(privateValue)
      expect(persisted).not.toContain(privateValue)
    }
    expect(report).toContain('SECRET_TOKEN=[redacted]')
    expect(report).toContain('Details in [redacted-path] token=[redacted]')
    expect(report).toContain(
      'Credentials [redacted-credential]@example.com and [redacted-path] secret=[redacted]'
    )
    expect(persisted).toContain('SECRET_TOKEN=[redacted]')
    expect(persisted).toContain('Details in [redacted-path] token=[redacted]')
    expect(persisted).toContain(
      'Credentials [redacted-credential]@example.com and [redacted-path] secret=[redacted]'
    )
  })

  it('retains a contained render failure after a normal background handoff', async () => {
    const storage = new MemoryStorage()
    const first = new MobileCrashSessionJournal(storage, { now: () => FIRST_SESSION_AT })
    await first.start()
    await first.recordRenderError(new Error('contained render failure'))
    await first.recordAppState('background')

    const second = new MobileCrashSessionJournal(storage, { now: () => SECOND_SESSION_AT })

    await expect(second.start()).resolves.toMatchObject({
      endedAbnormally: false,
      breadcrumbs: expect.arrayContaining([
        expect.objectContaining({ name: 'render_error_contained' })
      ])
    })
    await expect(
      second.buildReport({ version: '0.0.29', platform: 'android 15' })
    ).resolves.toContain('Previous session recovered from a render error')
    await expect(
      second.buildReport({ version: '0.0.29', platform: 'android 15' })
    ).resolves.not.toContain('Previous session ended abnormally')
  })

  it('does not classify a session backgrounded cleanly as a crash', async () => {
    const storage = new MemoryStorage()
    const first = new MobileCrashSessionJournal(storage, { now: () => FIRST_SESSION_AT })
    await first.start()
    await first.recordRoute(['settings'])
    await first.recordAppState('background')

    const second = new MobileCrashSessionJournal(storage, { now: () => SECOND_SESSION_AT })

    await expect(second.start()).resolves.toBeNull()
    await expect(second.getUndismissedLatestAbnormalSession()).resolves.toBeNull()
    await expect(
      second.buildReport({ version: '0.0.29', platform: 'android 15' })
    ).resolves.toContain('No previous abnormal session recorded.')
  })

  it('keeps a report dismissed across a clean relaunch without hiding the next crash', async () => {
    const storage = new MemoryStorage()
    const first = new MobileCrashSessionJournal(storage, { now: () => FIRST_SESSION_AT })
    await first.start()

    const second = new MobileCrashSessionJournal(storage, { now: () => SECOND_SESSION_AT })
    const previous = await second.start()
    expect(previous).not.toBeNull()
    await expect(second.getUndismissedLatestAbnormalSession()).resolves.toEqual(previous)

    await second.dismissLatestAbnormalSession(previous?.openedAt ?? '')
    await second.recordAppState('background')

    const third = new MobileCrashSessionJournal(storage, {
      now: () => SECOND_SESSION_AT + 30_000
    })
    await third.start()
    await expect(third.getUndismissedLatestAbnormalSession()).resolves.toBeNull()

    await third.recordRenderError(new Error('a different crash'))
    await third.recordAppState('background')
    const fourth = new MobileCrashSessionJournal(storage, {
      now: () => SECOND_SESSION_AT + 60_000
    })
    await fourth.start()
    await expect(fourth.getUndismissedLatestAbnormalSession()).resolves.toMatchObject({
      openedAt: new Date(SECOND_SESSION_AT + 30_000).toISOString()
    })
  })

  it('reopens the marker when a backgrounded process becomes active again', async () => {
    const storage = new MemoryStorage()
    const first = new MobileCrashSessionJournal(storage, { now: () => FIRST_SESSION_AT })
    await first.start()
    await first.recordAppState('inactive')
    await first.recordAppState('background')
    await first.recordAppState('active')

    const second = new MobileCrashSessionJournal(storage, { now: () => SECOND_SESSION_AT })

    await expect(second.start()).resolves.toMatchObject({
      breadcrumbs: [
        expect.objectContaining({ name: 'session_started' }),
        expect.objectContaining({ name: 'app_state_changed', data: { state: 'inactive' } }),
        expect.objectContaining({ name: 'app_state_changed', data: { state: 'background' } }),
        expect.objectContaining({ name: 'app_state_changed', data: { state: 'active' } })
      ]
    })
  })

  it('caps the persisted breadcrumb ring and payload', async () => {
    const storage = new MemoryStorage()
    const journal = new MobileCrashSessionJournal(storage, { now: () => FIRST_SESSION_AT })
    await journal.start()

    for (let index = 0; index < 80; index += 1) {
      await journal.recordRoute(['h', `host-${index}`, 'session', `worktree-${index}`])
    }

    const raw = storage.values.get(MOBILE_CRASH_SESSION_STORAGE_KEY)
    expect(raw?.length).toBeLessThanOrEqual(MAX_MOBILE_CRASH_DIAGNOSTICS_CHARS)
    expect(JSON.parse(raw ?? '{}').activeSession.breadcrumbs).toHaveLength(30)
  })
})
