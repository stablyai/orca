import { describe, expect, it, vi } from 'vitest'
import { buildGuestRendererGoneReporter } from './guest-renderer-gone-reporter'

describe('buildGuestRendererGoneReporter', () => {
  it('routes the webContents id and render-process-host id into their named fields', () => {
    const recordCrash = vi.fn()
    const reporter = buildGuestRendererGoneReporter(recordCrash)

    // Why: the ids deliberately differ so a transposition cannot stay green (#15063).
    reporter(
      { reason: 'crashed', exitCode: 133 } as Electron.RenderProcessGoneDetails,
      41,
      'browser-guest',
      7
    )

    expect(recordCrash).toHaveBeenCalledExactlyOnceWith(
      'renderer',
      'renderer',
      'crashed',
      133,
      {
        processType: 'renderer',
        rendererKind: 'browser-guest',
        webContentsId: 41,
        rendererProcessId: 7
      },
      { webContentsId: 41, rendererProcessId: 7 }
    )
  })

  it('reports an unreadable process identity without inventing one', () => {
    const recordCrash = vi.fn()
    const reporter = buildGuestRendererGoneReporter(recordCrash)

    reporter(
      { reason: 'killed', exitCode: 1 } as Electron.RenderProcessGoneDetails,
      205,
      'browser-popup',
      undefined
    )

    expect(recordCrash).toHaveBeenCalledExactlyOnceWith(
      'renderer',
      'renderer',
      'killed',
      1,
      { processType: 'renderer', rendererKind: 'browser-popup', webContentsId: 205 },
      { webContentsId: 205, rendererProcessId: undefined }
    )
    // Why: the details record must omit the key entirely, not carry undefined.
    expect('rendererProcessId' in (recordCrash.mock.calls[0]![4] as object)).toBe(false)
  })
})
