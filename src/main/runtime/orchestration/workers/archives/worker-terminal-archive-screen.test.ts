import { afterEach, describe, expect, it, vi } from 'vitest'
import { createTerminalArchiveFixture } from './worker-terminal-archive.test-support'
import { syncSinglePty } from '../../../orca-runtime-tests/orca-runtime-test-fixtures.spec'

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
