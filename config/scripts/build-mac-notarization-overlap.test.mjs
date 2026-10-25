import { describe, expect, it, vi } from 'vitest'
import { buildWithOverlappingNotarization } from './build-mac-notarization-overlap.mjs'

const deferred = () => {
  let resolve, reject
  const promise = new Promise((yes, no) => {
    resolve = yes
    reject = no
  })
  return { promise, resolve, reject }
}
const context = (arch) => ({
  arch,
  electronPlatformName: 'darwin',
  appOutDir: `dist/mac-${arch}`,
  packager: { appInfo: { productFilename: 'Orca' } }
})
const signedConfig = () => ({
  forceCodeSigning: true,
  mac: { notarize: true, hardenedRuntime: true },
  concurrency: { jobs: 8 },
  publish: { releaseType: 'draft' }
})
const options = (build, notarize = vi.fn(async () => {}), verify = vi.fn()) => ({
  config: signedConfig(),
  build,
  notarize,
  verify,
  targets: 'both-mac-targets',
  publish: 'never',
  credentials: { appleId: 'test' },
  log: vi.fn()
})

// The real builder queues each artifact task without awaiting it in its serial pack loop.
function queuedBuilder(events, afterSign) {
  return async ({ config, ...buildOptions }) => {
    expect(buildOptions).toMatchObject({ targets: 'both-mac-targets', publish: 'never' })
    expect(config.mac).toMatchObject({ notarize: false, hardenedRuntime: true })
    expect(config.forceCodeSigning).toBe(true)
    expect(config.concurrency.jobs).toBe(1)
    const artifacts = []
    for (const arch of [1, 3]) {
      events.push(`pack:${arch}`)
      await config.afterSign(context(arch))
      artifacts.push(
        (async () => {
          await config.artifactBuildStarted({ arch })
          events.push(`archive:${arch}`)
        })()
      )
      await afterSign?.(arch)
    }
    await Promise.all(artifacts)
    return ['x64.dmg', 'arm64.dmg']
  }
}

describe('overlapping macOS notarization', () => {
  it('packs serially, overlaps Apple waits, and gates every artifact on both verified tickets', async () => {
    const events = []
    const x64 = deferred(),
      arm64 = deferred(),
      bothSubmitted = deferred()
    const notarize = vi.fn(({ appPath }) => {
      events.push(`submit:${appPath}`)
      if (appPath.includes('mac-3')) {
        bothSubmitted.resolve()
      }
      return appPath.includes('mac-1') ? x64.promise : arm64.promise
    })
    const verify = vi.fn((appPath) => {
      events.push(`verify:${appPath}`)
    })
    const result = buildWithOverlappingNotarization(
      options(queuedBuilder(events), notarize, verify)
    )
    await bothSubmitted.promise
    expect(events.filter((event) => event.startsWith('pack:'))).toEqual(['pack:1', 'pack:3'])
    x64.resolve()
    await vi.waitFor(() => expect(verify).toHaveBeenCalledTimes(1))
    expect(events.some((event) => event.startsWith('archive:'))).toBe(false)
    arm64.resolve()
    await expect(result).resolves.toEqual(['x64.dmg', 'arm64.dmg'])
    expect(events.findIndex((event) => event.startsWith('archive:'))).toBeGreaterThan(
      events.findLastIndex((event) => event.startsWith('verify:'))
    )
  })

  it.each([1, 3])('never archives when architecture %i notarization fails', async (failedArch) => {
    const events = []
    const failure = new Error('Apple rejected the app')
    const notarize = vi.fn(async ({ appPath }) => {
      if (appPath.includes(`mac-${failedArch}`)) {
        throw failure
      }
    })
    await expect(
      buildWithOverlappingNotarization(options(queuedBuilder(events), notarize))
    ).rejects.toBe(failure)
    expect(events.some((event) => event.startsWith('archive:'))).toBe(false)
  })

  it('never archives when signature or stapler validation fails', async () => {
    const events = []
    await expect(
      buildWithOverlappingNotarization(
        options(queuedBuilder(events), undefined, () => {
          throw new Error('invalid staple')
        })
      )
    ).rejects.toThrow('invalid staple')
    expect(events.some((event) => event.startsWith('archive:'))).toBe(false)
  })

  it('rejects waiting artifacts and drains the first notary if the second pack fails', async () => {
    const waiting = deferred(),
      started = deferred()
    let artifactResult
    const failure = new Error('second native rebuild failed')
    const build = async ({ config }) => {
      await config.afterSign(context(1))
      artifactResult = config.artifactBuildStarted({ arch: 1 }).catch((error) => error)
      throw failure
    }
    const result = buildWithOverlappingNotarization(
      options(build, async () => {
        started.resolve()
        await waiting.promise
      })
    )
    const settled = vi.fn()
    result.catch(settled)
    await started.promise
    expect(await artifactResult).toBe(failure)
    expect(settled).not.toHaveBeenCalled()
    waiting.resolve()
    await expect(result).rejects.toBe(failure)
  })

  it('does not mask a build failure with a later notary failure', async () => {
    const failure = new Error('pack failed')
    const build = async ({ config }) => {
      await config.afterSign(context(1))
      throw failure
    }
    await expect(
      buildWithOverlappingNotarization(
        options(build, async () => {
          throw new Error('notary failed too')
        })
      )
    ).rejects.toBe(failure)
  })

  it('preserves hooks and runs artifact hooks after verification', async () => {
    const events = []
    const config = signedConfig()
    config.afterSign = vi.fn()
    config.artifactBuildStarted = vi.fn()
    await buildWithOverlappingNotarization({ ...options(queuedBuilder(events)), config })
    expect(config.afterSign).toHaveBeenCalledTimes(2)
    expect(config.artifactBuildStarted).toHaveBeenCalledTimes(2)
    expect(config.mac.notarize).toBe(true)
  })

  it.each([
    { forceCodeSigning: false },
    { mac: { notarize: false, hardenedRuntime: true } },
    { mac: { notarize: true, hardenedRuntime: false } },
    { afterSign: 'hook.cjs' }
  ])('fails closed on an unsupported signing policy: %j', async (override) => {
    const build = vi.fn()
    await expect(
      buildWithOverlappingNotarization({
        ...options(build),
        config: { ...signedConfig(), ...override }
      })
    ).rejects.toThrow()
    expect(build).not.toHaveBeenCalled()
  })

  it.each([
    [context(1), context(1)],
    [context(1), { ...context(3), appOutDir: 'dist/mac-1' }],
    [{ ...context(1), electronPlatformName: 'linux' }],
    [context(4)]
  ])('rejects duplicate, shared, or unexpected app bundles: %j', async (...contexts) => {
    const build = async ({ config }) => {
      for (const value of contexts) {
        await config.afterSign(value)
      }
    }
    await expect(buildWithOverlappingNotarization(options(build))).rejects.toThrow()
  })

  it('rejects a build that silently omits an architecture', async () => {
    const build = async ({ config }) => {
      await config.afterSign(context(1))
      return []
    }
    await expect(buildWithOverlappingNotarization(options(build))).rejects.toThrow('Both macOS')
  })
})
