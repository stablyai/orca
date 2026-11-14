import { mkdtempSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ThemeStudioDraft } from '../../shared/theme-studio/theme-studio-draft'
import type { ThemeStudioPreview } from '../../shared/theme-studio/theme-studio-protocol'
import { ThemeStudioSession } from './theme-studio-session'

const draftWith = (background: string): ThemeStudioDraft => ({
  name: 'Ember',
  light: null,
  dark: { tokens: { '--background': background, '--foreground': '#eeeeee' } }
})

describe('ThemeStudioSession', () => {
  let pushes: ThemeStudioPreview[]
  let session: ThemeStudioSession
  let sessionFile: string

  beforeEach(() => {
    vi.useFakeTimers()
    pushes = []
    sessionFile = join(mkdtempSync(join(tmpdir(), 'theme-studio-')), 'session.json')
    session = new ThemeStudioSession({ sessionFile, push: (preview) => pushes.push(preview) })
  })
  afterEach(() => vi.useRealTimers())

  it('paints a burst of edits once, with the last one', () => {
    session.begin(draftWith('#000000'), 'Start')
    session.commit(draftWith('#111111'), 'One')
    session.commit(draftWith('#222222'), 'Two')
    vi.advanceTimersByTime(20)
    expect(pushes).toEqual([{ revision: 3, draft: draftWith('#222222') }])
  })

  it('undoes and redoes, and a new edit drops what was undone', () => {
    session.begin(draftWith('#000000'), 'Start')
    session.commit(draftWith('#111111'), 'One')
    session.commit(draftWith('#222222'), 'Two')
    expect(session.step('undo')).toBe('Two')
    expect(session.draft).toEqual(draftWith('#111111'))
    expect(session.step('redo')).toBe('Two')
    session.step('undo')
    session.commit(draftWith('#333333'), 'Three')
    expect(session.status()).toMatchObject({ undo: 2, redo: 0 })
    expect(() => session.step('redo')).toThrow('Nothing to redo.')
  })

  it("answers a report wait only with the current revision's report", async () => {
    session.begin(draftWith('#000000'), 'Start')
    const waiting = session.waitForReport(1000)
    session.receiveReport({ revision: 0, modes: [] })
    session.receiveReport({ revision: 1, modes: [] })
    await expect(waiting).resolves.toEqual({ revision: 1, modes: [] })
  })

  it('survives a restart and ends cleanly', async () => {
    session.begin(draftWith('#000000'), 'Start')
    session.commit(draftWith('#111111'), 'One')
    await vi.advanceTimersByTimeAsync(300)
    vi.useRealTimers()
    await vi.waitFor(() => readFile(sessionFile, 'utf8'))
    const restored = new ThemeStudioSession({ sessionFile, push: () => undefined })
    await restored.load()
    expect(restored.draft).toEqual(draftWith('#111111'))
    expect(restored.status().undo).toBe(1)
    restored.end()
    expect(restored.draft).toBeNull()
    await vi.waitFor(() => expect(readFile(sessionFile, 'utf8')).rejects.toThrow())
  })
})
