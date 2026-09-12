import { mkdtemp, mkdir, writeFile, rm, access } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  verifyMacAppLaunch,
  verifyMacAppSignature,
  verifyMacSignedApp
} from './verify-macos-signed-app.mjs'

const roots = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true })))
  vi.unstubAllEnvs()
})

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'orca-signed-gate-test-'))
  roots.push(root)
  const app = join(root, 'Orca.app')
  const main = join(app, 'Contents', 'MacOS', 'Orca')
  const helper = join(
    app,
    'Contents',
    'Frameworks',
    'Orca Helper.app',
    'Contents',
    'MacOS',
    'Orca Helper'
  )
  for (const file of [main, helper]) {
    await mkdir(join(file, '..'), { recursive: true })
    await writeFile(file, Buffer.from('cffaedfe00000000', 'hex'))
  }
  return { root, app, main, helper }
}

function success(stdout = '') {
  return { code: 0, signal: null, timedOut: false, stdout, stderr: '' }
}

function signatureRunner(entitlements = () => ({})) {
  return vi.fn(async ({ program, args, input }) => {
    if (program.endsWith('/lipo')) {
      return success('arm64 x86_64')
    }
    if (program.endsWith('/codesign') && args[0] === '-d') {
      return success(JSON.stringify(entitlements(args.at(-1), args[2])))
    }
    if (program.endsWith('/plutil')) {
      return success(input)
    }
    return success()
  })
}

describe('signed macOS app policy', () => {
  it('checks the main and nested helpers in every architecture', async () => {
    const { app, main, helper } = await fixture()
    const run = signatureRunner()
    await verifyMacAppSignature(app, { run })
    for (const file of [main, helper]) {
      expect(run).toHaveBeenCalledWith(
        expect.objectContaining({ args: ['--verify', '--strict', '--all-architectures', file] })
      )
      for (const arch of ['arm64', 'x86_64']) {
        expect(run).toHaveBeenCalledWith(
          expect.objectContaining({ args: ['-d', '--arch', arch, '--entitlements', ':-', file] })
        )
      }
    }
  })

  it.each([
    'keychain-access-groups',
    'com.apple.application-identifier',
    'com.apple.developer.team-identifier'
  ])('rejects %s even in the other helper architecture', async (key) => {
    const { app, helper } = await fixture()
    const run = signatureRunner((file, arch) =>
      file === helper && arch === 'x86_64' ? { [key]: [] } : {}
    )
    await expect(verifyMacAppSignature(app, { run })).rejects.toThrow(
      'Restricted passkey entitlement'
    )
  })

  it('rejects embedded profiles before a launch or certificate can make them look safe', async () => {
    const { app } = await fixture()
    await writeFile(join(app, 'Contents', 'embedded.provisionprofile'), 'expired or valid alike')
    const run = signatureRunner()
    await expect(verifyMacAppSignature(app, { run })).rejects.toThrow(
      'Provisioning profiles are forbidden'
    )
    expect(run).not.toHaveBeenCalled()
  })

  it('propagates signature verification failures before launch', async () => {
    const { root } = await fixture()
    const run = vi.fn(async () => ({ ...success(), code: 1, stderr: 'invalid signature' }))
    await expect(
      verifyMacSignedApp(
        {
          electronPlatformName: 'darwin',
          appOutDir: root,
          packager: { appInfo: { productFilename: 'Orca' } }
        },
        { run }
      )
    ).rejects.toThrow('invalid signature')
    expect(run).toHaveBeenCalledTimes(1)
  })
})

function launchRunner(outcome) {
  const termination = {
    signalProcessTree: vi.fn(async () => true),
    forceTerminateProcessTree: vi.fn(async () => true)
  }
  const run = vi.fn(async (spec) => {
    if (spec.program.endsWith('/plutil')) {
      return success('{"CFBundleExecutable":"Orca"}')
    }
    if (outcome === 'killed') {
      return { ...success(), code: null, signal: 'SIGKILL' }
    }
    if (outcome === 'error') {
      throw new Error('spawn failed')
    }
    await spec.terminationBarrier.signal({
      pid: 123,
      exitCode: outcome === 'exited-with-open-pipes' ? 0 : null,
      signalCode: null
    })
    await spec.terminationBarrier.force({ pid: 123 })
    return { ...success(), timedOut: true, signal: 'SIGTERM' }
  })
  return { run, termination }
}

describe('signed app launch survival', () => {
  it('launches the exact signed executable hidden with disposable home and profile, then cleans up', async () => {
    vi.stubEnv('ELECTRON_RUN_AS_NODE', '1')
    vi.stubEnv('ORCA_E2E_FOREGROUND', '1')
    const { app, main } = await fixture()
    const deps = launchRunner('alive')
    await verifyMacAppLaunch(app, deps)
    const spec = deps.run.mock.calls[1][0]
    expect(spec.program).toBe(main)
    expect(spec.timeoutMs).toBe(10_000)
    expect(spec.detached).toBe(true)
    expect(spec.env).toMatchObject({
      ORCA_BACKGROUND_LAUNCH: '1',
      ORCA_E2E_HEADLESS: '1',
      HOME: spec.env.ORCA_E2E_HOME_DIR
    })
    expect(spec.env.ELECTRON_RUN_AS_NODE).toBeUndefined()
    expect(spec.env.ORCA_E2E_FOREGROUND).toBeUndefined()
    expect(spec.env.ORCA_E2E_USER_DATA_DIR).toBe(join(spec.cwd, '..', 'user-data'))
    expect(deps.termination.forceTerminateProcessTree).toHaveBeenCalled()
    await expect(access(spec.cwd)).rejects.toThrow()
  })

  it.each(['killed', 'error', 'exited-with-open-pipes'])(
    'fails for %s and cleans its profile',
    async (outcome) => {
      const { app } = await fixture()
      const deps = launchRunner(outcome)
      await expect(verifyMacAppLaunch(app, deps)).rejects.toThrow(
        outcome === 'error' ? 'spawn failed' : 'Signed app exited'
      )
      await expect(access(deps.run.mock.calls[1][0].cwd)).rejects.toThrow()
    }
  )

  it('fails if the probe tree could not be terminated', async () => {
    const { app } = await fixture()
    const deps = launchRunner('alive')
    deps.termination.forceTerminateProcessTree.mockResolvedValue(false)
    await expect(verifyMacAppLaunch(app, deps)).rejects.toThrow('Could not verify')
  })
})
