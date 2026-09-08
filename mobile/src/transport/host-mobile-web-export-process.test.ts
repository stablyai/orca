import { EventEmitter } from 'node:events'
import { describe, expect, it, vi } from 'vitest'
import {
  createHostMobileWebExportProcessSpec,
  runHostMobileWebExport
} from '../../scripts/export-host-mobile-web.mjs'
import { resolveSpawn } from '../../../src/shared/child-process/run-process'

describe('host mobile web export process', () => {
  it('passes adversarial Windows output argv directly to the Expo CLI', () => {
    const outputDirectory =
      'C:\\exports\\space & pipe| redirect<out> percent%PATH% bang! caret^ quote" trail\\'
    const spec = createHostMobileWebExportProcessSpec({
      expoCli: 'C:\\Orca Workspace\\mobile\\node_modules\\expo\\bin\\cli',
      mobileDirectory: 'C:\\Orca Workspace',
      nodeExecutable: 'C:\\Program Files\\nodejs\\node.exe',
      outputDirectory
    })
    const resolved = resolveSpawn(spec, 'win32')

    expect(spec.args).toEqual([
      'C:\\Orca Workspace\\mobile\\node_modules\\expo\\bin\\cli',
      'export',
      '--platform',
      'web',
      '--output-dir',
      outputDirectory
    ])
    expect(spec.args.at(-1)).toBe(outputDirectory)
    expect(resolved.file).toBe('C:\\Program Files\\nodejs\\node.exe')
    expect(resolved.options).toMatchObject({
      shell: false,
      windowsHide: true
    })
    expect(resolved.options.windowsVerbatimArguments).toBeUndefined()
    expect(resolved.args).toEqual(spec.args)
  })

  it('returns the child exit code unchanged', async () => {
    const child = new EventEmitter()
    const pending = runHostMobileWebExport({
      outputDirectory: '/tmp/export',
      spawn: vi.fn(() => child)
    })

    child.emit('exit', 23, null)

    await expect(pending).resolves.toBe(23)
  })

  it('maps a child signal to failure and reports the signal', async () => {
    const child = new EventEmitter()
    const stderr = { write: vi.fn() }
    const pending = runHostMobileWebExport({
      outputDirectory: '/tmp/export',
      spawn: vi.fn(() => child),
      stderr
    })

    child.emit('exit', null, 'SIGTERM')

    await expect(pending).resolves.toBe(1)
    expect(stderr.write).toHaveBeenCalledWith('Expo web export terminated by SIGTERM\n')
  })
})
