import { describe, expect, it } from 'vitest'
import { collectServeStatsBrowserPageMemory } from './serve-stats-browser-pages'

const KIB = 1024
const MIB = 1024 ** 2

// #14552: six agent-opened headless tabs, one of them a 1.3 GB renderer.
const RSS_BY_PID: Record<number, number> = {
  4101: 1_300_000 * KIB,
  4102: 220_000 * KIB,
  4103: 180_000 * KIB
}

function sources(overrides: Parameters<typeof collectServeStatsBrowserPageMemory>[1] = {}) {
  return {
    platform: 'linux' as NodeJS.Platform,
    // WebContents id 501 → pid 4101, and so on: the registration map only knows WebContents ids.
    osProcessId: (webContentsId: number) => webContentsId - 501 + 4101,
    readProcStatus: (pid: number) =>
      RSS_BY_PID[pid] === undefined
        ? null
        : [
            `Name:\tchrome`,
            `VmSize:\t 9999999 kB`,
            `VmRSS:\t ${RSS_BY_PID[pid]! / KIB} kB`,
            ''
          ].join('\n'),
    ...overrides
  }
}

describe('collectServeStatsBrowserPageMemory', () => {
  it('sums each renderer once and reports the largest single footprint', () => {
    const memory = collectServeStatsBrowserPageMemory([501, 502, 503], sources())

    expect(memory).toEqual({
      totalBytes: 1_700_000 * KIB,
      // The whole reason this field exists: one 1.3 GB page among three is a different incident
      // from three even ones, and the total alone cannot tell them apart.
      maxBytes: 1_300_000 * KIB
    })
  })

  it('counts a renderer shared by several pages once, not once per page', () => {
    const shared = collectServeStatsBrowserPageMemory([501, 502, 503], {
      ...sources(),
      // Electron may back several pages with one renderer process.
      osProcessId: () => 4102
    })

    expect(shared).toEqual({ totalBytes: 220_000 * KIB, maxBytes: 220_000 * KIB })
  })

  it('reports null, never zero, where no footprint can be measured', () => {
    const windows = collectServeStatsBrowserPageMemory([501], sources({ platform: 'win32' }))
    const noPages = collectServeStatsBrowserPageMemory([], sources())
    const destroyed = collectServeStatsBrowserPageMemory(
      [501],
      sources({ osProcessId: () => null })
    )
    const noProcfs = collectServeStatsBrowserPageMemory(
      [501],
      sources({ readProcStatus: () => null })
    )

    // A 0 total would claim renderers measured at no cost; `counts.browserPages` is what
    // distinguishes "no pages" from "pages this platform cannot measure".
    expect(windows).toEqual({ totalBytes: null, maxBytes: null })
    expect(noPages).toEqual({ totalBytes: null, maxBytes: null })
    expect(destroyed).toEqual({ totalBytes: null, maxBytes: null })
    expect(noProcfs).toEqual({ totalBytes: null, maxBytes: null })
  })

  it('reports the renderers it could read when one page dies mid-poll', () => {
    // 504 has no procfs entry: the renderer exited between the registration read and this one.
    const memory = collectServeStatsBrowserPageMemory([502, 504], sources())

    expect(memory).toEqual({ totalBytes: 220_000 * KIB, maxBytes: 220_000 * KIB })
  })

  it('ignores a status file with no VmRSS line rather than counting it as zero', () => {
    const memory = collectServeStatsBrowserPageMemory([501, 502], {
      ...sources(),
      readProcStatus: (pid: number) =>
        pid === 4101 ? 'Name:\tchrome\nVmSize:\t 100 kB\n' : `VmRSS:\t ${(220 * MIB) / KIB} kB\n`
    })

    expect(memory).toEqual({ totalBytes: 220 * MIB, maxBytes: 220 * MIB })
  })
})
