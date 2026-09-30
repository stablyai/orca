import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { assertBundledOrcadRuntime } from './orcad-bundled-runtime'
import { ORCAD_BUN_VERSION } from '../../shared/orcad-bun-runtime'
import { ORCAD_VERSION_FILENAME } from '../../shared/orcad-artifacts'

const fixture = vi.hoisted(() => ({
  exists: vi.fn<(path: string) => boolean>(),
  realpath: vi.fn<(path: string) => string>(),
  spawn: vi.fn()
}))
vi.mock('node:fs', () => ({ existsSync: fixture.exists, realpathSync: fixture.realpath }))
vi.mock('../../shared/child-process/run-process', () => ({ spawnProcess: fixture.spawn }))

beforeEach(() => {
  vi.spyOn(process, 'versions', 'get').mockReturnValue({
    ...process.versions,
    bun: ORCAD_BUN_VERSION
  })
  fixture.exists.mockReturnValue(true)
  fixture.realpath.mockImplementation((path) => path)
  vi.spyOn(process, 'exit').mockImplementation(() => {
    throw new Error('test process exit')
  })
  vi.spyOn(process, 'kill').mockReturnValue(true)
  vi.spyOn(console, 'error').mockImplementation(() => {})
  vi.spyOn(process, 'argv', 'get').mockReturnValue(['/node', '/slot/orcad.js', '--port', '0'])
})

afterEach(() => {
  vi.restoreAllMocks()
  vi.clearAllMocks()
})

describe('bundled Orca runtime validation', () => {
  it('leaves nonpackaged entries on their existing runtime', () => {
    fixture.exists.mockReturnValue(false)
    expect(assertBundledOrcadRuntime()).toBeUndefined()
    expect(fixture.spawn).not.toHaveBeenCalled()
  })

  it('refuses an incomplete slot before starting a process', () => {
    fixture.exists.mockImplementation((path) => path.endsWith('.build-target'))
    expect(() => assertBundledOrcadRuntime()).toThrow('bundled Orca runtime is missing')
    expect(fixture.spawn).not.toHaveBeenCalled()
  })

  it('refuses a versioned slot missing both its runtime and target marker', () => {
    fixture.exists.mockImplementation((path) => path.endsWith(ORCAD_VERSION_FILENAME))
    expect(() => assertBundledOrcadRuntime()).toThrow('bundled Orca runtime target is missing')
    expect(fixture.spawn).not.toHaveBeenCalled()
  })

  it('refuses a remaining bundled runtime without its target marker', () => {
    fixture.exists.mockImplementation((path) => !path.endsWith('.build-target'))
    expect(() => assertBundledOrcadRuntime()).toThrow('bundled Orca runtime target is missing')
    expect(fixture.realpath).toHaveBeenCalledExactlyOnceWith('/slot/orcad.js')
    expect(fixture.spawn).not.toHaveBeenCalled()
  })

  it('accepts only the pinned version when already executing the bundled runtime', () => {
    fixture.realpath.mockReturnValue('/real/runtime')
    vi.spyOn(process, 'versions', 'get').mockReturnValue({
      ...process.versions,
      bun: ORCAD_BUN_VERSION
    })
    expect(assertBundledOrcadRuntime()).toBeUndefined()
    expect(fixture.spawn).not.toHaveBeenCalled()
  })

  it('refuses an adjacent runtime that reports the wrong Bun version', () => {
    fixture.realpath.mockReturnValue('/real/runtime')
    vi.spyOn(process, 'versions', 'get').mockReturnValue({ ...process.versions, bun: '0.0.0' })
    expect(() => assertBundledOrcadRuntime()).toThrow(`must be Bun ${ORCAD_BUN_VERSION}`)
  })

  it('rejects Node before inspecting or opening the application', () => {
    vi.spyOn(process, 'versions', 'get').mockReturnValue({ ...process.versions, bun: undefined })
    expect(() => assertBundledOrcadRuntime()).toThrow('not Node')
    expect(fixture.exists).not.toHaveBeenCalled()
    expect(fixture.spawn).not.toHaveBeenCalled()
  })

  it('rejects an external Bun executable instead of handing off', () => {
    expect(() => assertBundledOrcadRuntime()).toThrow('Start orcad with its bundled runtime')
    expect(fixture.spawn).not.toHaveBeenCalled()
  })
})
