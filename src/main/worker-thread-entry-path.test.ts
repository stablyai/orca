import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { currentWorkerEntryLayout, resolveWorkerThreadEntryPath } from './worker-thread-entry-path'

describe('worker-thread entry path', () => {
  const outMain = join('/repo', 'out', 'main')

  it('resolves an unpackaged caller bundled into a shared chunk beside the main entry', () => {
    const layout = currentWorkerEntryLayout(join(outMain, 'chunks'))
    expect(resolveWorkerThreadEntryPath({ ...layout, isPackaged: false }, 'entry.js')).toBe(
      join(outMain, 'entry.js')
    )
  })

  it('keeps an unpackaged caller already in the main entry folder', () => {
    const layout = currentWorkerEntryLayout(outMain)
    expect(resolveWorkerThreadEntryPath({ ...layout, isPackaged: false }, 'entry.js')).toBe(
      join(outMain, 'entry.js')
    )
  })

  it('resolves packaged builds from resources, whatever the caller chunk', () => {
    const layout = { isPackaged: true, resourcesPath: '/res', moduleDir: join(outMain, 'chunks') }
    expect(resolveWorkerThreadEntryPath(layout, 'entry.js')).toBe(
      join('/res', 'app.asar', 'out', 'main', 'entry.js')
    )
  })
})
