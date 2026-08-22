import { createRequire } from 'node:module'
import { resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { collectDevChannelPackagingProblems } from './verify-dev-channel-packaging.mjs'

const require = createRequire(import.meta.url)
const CONFIG_PATH = resolve(import.meta.dirname, '../electron-builder.config.cjs')

/** The config reads process.env at require time, so each identity needs a fresh load. */
function loadConfigWithEnv(env) {
  const saved = { ...process.env }
  for (const key of Object.keys(process.env)) {
    if (key.startsWith('ORCA_')) {
      delete process.env[key]
    }
  }
  Object.assign(process.env, env)
  try {
    delete require.cache[require.resolve(CONFIG_PATH)]
    return require(CONFIG_PATH)
  } finally {
    process.env = saved
    delete require.cache[require.resolve(CONFIG_PATH)]
  }
}

const WIN_ADHOC_ENV = {
  ORCA_WIN_ADHOC: '1',
  ORCA_ADHOC_BUILD_VERSION: '1.4.178-adhoc.20260819010203'
}

afterEach(() => {
  delete require.cache[require.resolve(CONFIG_PATH)]
})

describe('electron-builder dev-channel identity', () => {
  it('keeps the SignPath publisherName on stable Windows builds', () => {
    const config = loadConfigWithEnv({})

    expect(config.win.signtoolOptions.publisherName).toBe('SignPath Foundation')
    expect(config.win.verifyUpdateCodeSignature).toBeUndefined()
    expect(config.publish.repo).toBe('orca')
    expect(config.publish.releaseType).toBe('release')
  })

  // The whole point of the change: an unsigned build that advertised a
  // publisherName would Authenticode-verify — and reject — every installer it
  // ever downloaded, including its own way back to stable.
  it('drops the publisherName and disables update signature checks on Windows dev builds', () => {
    const config = loadConfigWithEnv(WIN_ADHOC_ENV)

    expect(config.win.signtoolOptions?.publisherName).toBeUndefined()
    expect(config.win.verifyUpdateCodeSignature).toBe(false)
  })

  it.each([
    ['hourly', { ORCA_WIN_HOURLY: '1' }, 'orca-hourly'],
    ['daily', { ORCA_WIN_DAILY: '1' }, 'orca-daily'],
    ['adhoc', { ORCA_WIN_ADHOC: '1' }, 'orca-adhoc']
  ])('publishes %s Windows builds to its own repo as a prerelease', (_channel, env, repo) => {
    const config = loadConfigWithEnv(env)

    expect(config.publish.repo).toBe(repo)
    expect(config.publish.releaseType).toBe('prerelease')
  })

  // Why: ORCA_MAC_* gates hardened runtime, notarization, and root-level
  // forceCodeSigning. If the Windows variables leaked into that, the Windows job
  // would fail packaging for want of a cert it deliberately does not use.
  it('leaves mac release signing off for Windows dev builds', () => {
    const config = loadConfigWithEnv(WIN_ADHOC_ENV)

    expect(config.forceCodeSigning).toBe(false)
    expect(config.mac.notarize).toBe(false)
    expect(config.mac.hardenedRuntime).toBe(false)
  })

  it('still notarizes mac dev builds', () => {
    const config = loadConfigWithEnv({
      ORCA_MAC_ADHOC: '1',
      ORCA_ADHOC_BUILD_VERSION: '1.4.178-adhoc.20260819010203'
    })

    expect(config.mac.notarize).toBe(true)
    expect(config.publish.repo).toBe('orca-adhoc')
  })
})

describe('collectDevChannelPackagingProblems', () => {
  const goodWinConfig = {
    publish: { repo: 'orca-adhoc', releaseType: 'prerelease' },
    extraMetadata: { version: '1.4.178-adhoc.20260819010203' },
    win: { verifyUpdateCodeSignature: false }
  }
  const env = { ORCA_ADHOC_BUILD_VERSION: '1.4.178-adhoc.20260819010203' }

  it('accepts a correctly configured Windows dev build', () => {
    expect(
      collectDevChannelPackagingProblems({
        channel: 'adhoc',
        platform: 'win32',
        config: goodWinConfig,
        env
      })
    ).toEqual([])
  })

  // The failure this script exists for: a branch predating Windows dev builds
  // resolves publish.repo to the main repo.
  it('rejects a config that resolved the main repo', () => {
    const problems = collectDevChannelPackagingProblems({
      channel: 'adhoc',
      platform: 'win32',
      config: { ...goodWinConfig, publish: { repo: 'orca', releaseType: 'release' } },
      env
    })

    expect(problems.join('\n')).toContain('must publish to "orca-adhoc"')
    expect(problems.join('\n')).toContain('rebase it onto a main that does')
  })

  it('rejects a Windows dev build that still advertises a publisherName', () => {
    const problems = collectDevChannelPackagingProblems({
      channel: 'adhoc',
      platform: 'win32',
      config: {
        ...goodWinConfig,
        win: { signtoolOptions: { publisherName: 'SignPath Foundation' } }
      },
      env
    })

    expect(problems.join('\n')).toContain('verifyUpdateCodeSignature must be false')
    expect(problems.join('\n')).toContain('publisherName is set to "SignPath Foundation"')
  })

  it('rejects a build packaging a version other than the tag the workflow created', () => {
    const problems = collectDevChannelPackagingProblems({
      channel: 'adhoc',
      platform: 'win32',
      config: { ...goodWinConfig, extraMetadata: { version: '1.4.178' } },
      env
    })

    expect(problems.join('\n')).toContain('but the workflow computed')
  })

  // macOS builds are signed, so the Windows-only assertions must not fire there.
  it('does not apply Windows signature rules to a mac dev build', () => {
    expect(
      collectDevChannelPackagingProblems({
        channel: 'adhoc',
        platform: 'darwin',
        config: {
          publish: { repo: 'orca-adhoc', releaseType: 'prerelease' },
          extraMetadata: { version: '1.4.178-adhoc.20260819010203' },
          win: { signtoolOptions: { publisherName: 'SignPath Foundation' } }
        },
        env
      })
    ).toEqual([])
  })

  it('rejects an unknown channel', () => {
    expect(
      collectDevChannelPackagingProblems({
        channel: 'nightly',
        platform: 'win32',
        config: goodWinConfig,
        env
      })
    ).toEqual(['Unknown dev channel "nightly"; expected one of hourly, daily, adhoc.'])
  })
})
