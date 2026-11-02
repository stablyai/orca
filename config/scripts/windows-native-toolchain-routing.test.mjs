import { describe, expect, it, vi } from 'vitest'
import { classifyPrJobs } from './pr-code-change-scope.mjs'
import { classifyNodeServerChanges } from './node-server-change-scope.mjs'
import { nodeServerQualification } from './node-server-qualification.mjs'

const toolchainSources = [
  'config/scripts/initialize-windows-native-toolchain.mjs',
  'config/scripts/capture-windows-native-environment.cmd'
]

describe('Windows native toolchain CI routing', () => {
  it.each(toolchainSources)(
    'prepares native caches and packages for a change to %s alone',
    (file) => {
      expect(classifyPrJobs([file])).toMatchObject({
        should_run: true,
        native_cache_changed: true,
        package: true,
        package_windows: true
      })
    }
  )

  it.each(toolchainSources)(
    'selects both Windows server runners for a change to %s alone',
    async (file) => {
      const collect = vi.fn(async () => new Set())
      for (const options of [
        {},
        { deferGraph: true },
        { modifiedFiles: [file] },
        { deferGraph: true, modifiedFiles: [file] }
      ]) {
        const scope = await classifyNodeServerChanges([file], collect, options)
        expect(scope).toEqual({ shouldRun: true, reason: `Build or CI input changed: ${file}` })
        expect(nodeServerQualification([file], scope)).toEqual({
          qualification: false,
          runners: ['ubuntu-22.04', 'windows-2022', 'windows-11-arm']
        })
      }
      expect(collect).not.toHaveBeenCalled()
    }
  )

  it('preserves unrelated build-script routing', async () => {
    const file = 'config/scripts/unrelated-toolchain.mjs'
    expect(classifyPrJobs([file])).toMatchObject({
      test: true,
      native_cache_changed: false,
      package: false,
      package_windows: false
    })
    expect((await classifyNodeServerChanges([file], async () => new Set())).shouldRun).toBe(false)
  })
})
