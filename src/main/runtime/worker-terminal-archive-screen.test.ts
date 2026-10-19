import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  ARCHIVE_SCREEN_LINES,
  createTerminalArchiveFixture
} from './worker-terminal-archive.test-support'
import { syncSinglePty } from './orca-runtime-test-fixtures.spec'

afterEach(() => vi.restoreAllMocks())

describe('worker archive through real terminal read routing', () => {
  it('keeps history and current-screen boundaries independent for masking', async () => {
    const history = `dcap_${'s'.repeat(5)}`
    const screen = 's'.repeat(19)
    const fixture = await createTerminalArchiveFixture({
      provider: true,
      screenLines: [screen, 'Safe diagnostic']
    })
    fixture.runtime.onPtyData('pty-1', `${history}\r\n`, Date.now())
    const archive = await fixture.capture()
    if (archive.kind !== 'terminal_tail') {
      throw new Error('Expected terminal archive')
    }
    expect(archive.content.lines).toEqual([history, screen, 'Safe diagnostic'])
    expect(archive.content.warnings).not.toContain(
      'Dispatch capability tokens were redacted from terminal output.'
    )
  })

  it('keeps an ordinary live stream without duplicating an identical screen', async () => {
    const fixture = await createTerminalArchiveFixture({ hydrate: false })
    fixture.runtime.onPtyData('pty-1', `${ARCHIVE_SCREEN_LINES.join('\r\n')}\r\n`, Date.now())
    const archive = await fixture.capture()
    if (archive.kind !== 'terminal_tail') {
      throw new Error('Expected terminal archive')
    }
    expect(archive.content.lines).toEqual(ARCHIVE_SCREEN_LINES)
    expect(archive.content.warnings).toEqual([])
  })

  it.each(['\r\n'.repeat(7), `host % codex\r\n${'\r\n'.repeat(6)}`])(
    'preserves a populated normal screen alongside a short stream (%j)',
    async (stream) => {
      const fixture = await createTerminalArchiveFixture()
      fixture.runtime.onPtyData('pty-1', stream, Date.now())
      const preview = await fixture.runtime.readTerminal(fixture.handle)
      expect(preview.source).toBe('stream')
      expect(preview.tail).not.toContain(ARCHIVE_SCREEN_LINES[1])

      const archive = await fixture.capture()

      expect(archive.kind).toBe('terminal_tail')
      expect(archive.status).toBe('captured')
      if (archive.kind !== 'terminal_tail') {
        throw new Error('Expected terminal archive')
      }
      expect(archive.content.lines).toEqual(expect.arrayContaining(ARCHIVE_SCREEN_LINES))
      expect(archive.content.warnings.join(' ')).toContain('screen')
      if (stream.includes('host % codex')) {
        expect(archive.content.lines).toContain('host % codex')
      }
    }
  )

  it('preserves retained history beyond the preview and the current screen', async () => {
    const fixture = await createTerminalArchiveFixture({ provider: true })
    const history = Array.from({ length: 180 }, (_, index) => `history ${index}`)
    fixture.runtime.onPtyData('pty-1', `${history.join('\r\n')}\r\n`, Date.now())
    expect((await fixture.runtime.readTerminal(fixture.handle)).tail).not.toContain('history 0')

    const archive = await fixture.capture()

    if (archive.kind !== 'terminal_tail') {
      throw new Error('Expected terminal archive')
    }
    expect(archive.content.lines).toEqual(
      expect.arrayContaining([...history, ...ARCHIVE_SCREEN_LINES])
    )
    expect(archive.content.warnings.join(' ')).toContain('screen')
  })

  it('preserves the alternate screen using the same capture path', async () => {
    const fixture = await createTerminalArchiveFixture({ alternate: true })
    fixture.runtime.onPtyData('pty-1', '\r\n'.repeat(7), Date.now())
    const archive = await fixture.capture()
    if (archive.kind !== 'terminal_tail') {
      throw new Error('Expected terminal archive')
    }
    expect(archive.content.lines).toEqual(expect.arrayContaining(ARCHIVE_SCREEN_LINES))
  })

  it('allows a genuinely empty terminal with honest unavailable-screen provenance', async () => {
    const fixture = await createTerminalArchiveFixture({ screenLines: [], hydrate: false })
    const archive = await fixture.capture()
    expect(archive.status).toBe('empty')
    if (archive.kind !== 'terminal_tail') {
      throw new Error('Expected terminal archive')
    }
    expect(archive.content.lines.every((line) => line.trim() === '')).toBe(true)
    expect(archive.content.warnings.join(' ')).toContain('screen was unavailable')
  })

  it.each(['unavailable', 'stale'] as const)(
    'preserves useful stream output when the provider screen is %s',
    async (authority) => {
      const fixture = await createTerminalArchiveFixture({ provider: true })
      fixture.runtime.onPtyData('pty-1', 'retained diagnostic\r\npartial output', Date.now())
      if (authority === 'unavailable') {
        fixture.serializeProviderBuffer.mockRejectedValue(new Error('Host snapshot unavailable'))
      } else {
        fixture.serializeProviderBuffer.mockResolvedValue({
          data: 'untrusted old screen\r\n',
          cols: 100,
          rows: 30,
          seq: 0,
          source: 'headless',
          alternateScreen: false
        })
      }

      const archive = await fixture.capture()

      expect(archive.status).toBe('captured')
      if (archive.kind !== 'terminal_tail') {
        throw new Error('Expected terminal archive')
      }
      expect(archive.content.lines).toContain('retained diagnostic')
      expect(archive.content.lines).toContain('partial output')
      expect(archive.content.lines.join('\n')).not.toContain('untrusted old screen')
      expect(archive.content.warnings.join(' ')).toContain('screen was unavailable')
    }
  )

  it('preserves and redacts a composer draft from the authoritative screen', async () => {
    const fixture = await createTerminalArchiveFixture({ hydrate: false })
    const secret = `dcap_${'d'.repeat(24)}`
    fixture.runtime.onPtyData('pty-1', `output\r\n────────\r\n❯ ${secret}`, Date.now())

    const archive = await fixture.capture()

    if (archive.kind !== 'terminal_tail') {
      throw new Error('Expected terminal archive')
    }
    expect(archive.content.draft).toBe('[dispatch capability redacted]')
    expect(JSON.stringify(archive.content)).not.toContain(secret)
    expect(archive.content.lines).toContain('output')
  })

  it('refuses capture when the terminal handle changes during a host screen read', async () => {
    const fixture = await createTerminalArchiveFixture({ provider: true })
    fixture.runtime.onPtyData('pty-1', 'retained diagnostic\r\n', Date.now())
    const snapshot = {
      data: 'Wrong terminal frame\r\n',
      cols: 100,
      rows: 30,
      seq: 900,
      source: 'headless' as const,
      alternateScreen: false
    }
    let resolveSnapshot!: (value: typeof snapshot) => void
    fixture.serializeProviderBuffer.mockResolvedValue(snapshot).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveSnapshot = resolve
        })
    )
    const capture = fixture.capture()
    await vi.waitFor(() => expect(fixture.serializeProviderBuffer).toHaveBeenCalledOnce())
    syncSinglePty(fixture.runtime, 'pty-2')
    resolveSnapshot(snapshot)

    await expect(capture).rejects.toThrow('terminal_handle_stale')
  })

  it('redacts stream and screen evidence before applying the durable budget', async () => {
    const secret = `dcap_${'s'.repeat(24)}`
    const fixture = await createTerminalArchiveFixture({
      screenLines: [`screen ${secret}`],
      provider: true
    })
    fixture.runtime.onPtyData(
      'pty-1',
      `${Array.from(
        { length: 1800 },
        (_, index) => `history ${index} ${'x'.repeat(150)} ${secret}`
      ).join('\r\n')}\r\n`,
      Date.now()
    )

    const archive = await fixture.capture()

    if (archive.kind !== 'terminal_tail') {
      throw new Error('Expected terminal archive')
    }
    expect(JSON.stringify(archive.content)).not.toContain(secret)
    expect(archive.content.lines).toContain('screen [dispatch capability redacted]')
    expect(archive.content.lines.some((line) => line.includes('history 1799'))).toBe(true)
    expect(
      archive.content.lines.reduce((total, line) => total + line.length + 1, 0)
    ).toBeLessThanOrEqual(262_144)
    expect(archive.content.truncated).toBe(true)
    expect(archive.content.clipping).toContain('terminal_buffer')
  })
})
