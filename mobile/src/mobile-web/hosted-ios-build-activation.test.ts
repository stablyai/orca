import { createHash } from 'node:crypto'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { waitForHostedIosBuildActivation } from '../../scripts/hosted-ios-build-activation.mjs'

const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true }))
  )
})

describe('hosted iOS build activation wait', () => {
  it('waits against the installed app data container', async () => {
    const appDataPath = await mkdtemp(path.join(os.tmpdir(), 'orca-ios-activation-'))
    const runtimeDirectory = await mkdtemp(path.join(os.tmpdir(), 'orca-ios-runtime-'))
    temporaryDirectories.push(appDataPath)
    temporaryDirectories.push(runtimeDirectory)
    const publicKeyB64 = 'paired-public-key'
    const hostIdentity = createHash('sha256').update(publicKeyB64).digest('hex')
    const buildId = 'a'.repeat(64)
    const hostRoot = path.join(
      appDataPath,
      'Library',
      'Application Support',
      'OrcaMobileWeb',
      hostIdentity
    )
    await mkdir(hostRoot, { recursive: true })
    await writeFile(
      path.join(hostRoot, 'activation.json'),
      JSON.stringify({ active: buildId, previous: null })
    )
    const keypairRoot = path.join(runtimeDirectory, 'paired-host', 'userData')
    await mkdir(keypairRoot, { recursive: true })
    await writeFile(
      path.join(keypairRoot, 'orca-e2ee-keypair.json'),
      JSON.stringify({ publicKeyB64 })
    )
    const runCommand = vi.fn().mockResolvedValue({ stdout: `${appDataPath}\n` })

    await expect(
      waitForHostedIosBuildActivation(
        'simulator',
        { expectedBuild: buildId, timeoutMs: 1_000 },
        runtimeDirectory,
        runCommand
      )
    ).resolves.toBeUndefined()
    expect(runCommand).toHaveBeenCalledWith('xcrun', [
      'simctl',
      'get_app_container',
      'simulator',
      'com.stably.orca.mobile',
      'data'
    ])
  })

  it('does not inspect the simulator without an expected build', async () => {
    const runCommand = vi.fn()

    await waitForHostedIosBuildActivation(
      'simulator',
      { expectedBuild: undefined, timeoutMs: 1_000 },
      '/runtime',
      runCommand
    )
    expect(runCommand).not.toHaveBeenCalled()
  })

  it('ignores the same active build under an unrelated host identity', async () => {
    const appDataPath = await mkdtemp(path.join(os.tmpdir(), 'orca-ios-activation-'))
    const runtimeDirectory = await mkdtemp(path.join(os.tmpdir(), 'orca-ios-runtime-'))
    temporaryDirectories.push(appDataPath)
    temporaryDirectories.push(runtimeDirectory)
    const publicKeyB64 = 'expected-paired-public-key'
    const expectedIdentity = createHash('sha256').update(publicKeyB64).digest('hex')
    const unrelatedIdentity = 'f'.repeat(64)
    const buildId = 'b'.repeat(64)
    const cacheRoot = path.join(appDataPath, 'Library', 'Application Support', 'OrcaMobileWeb')
    const keypairRoot = path.join(runtimeDirectory, 'paired-host', 'userData')
    await mkdir(path.join(cacheRoot, unrelatedIdentity), { recursive: true })
    await mkdir(keypairRoot, { recursive: true })
    await writeFile(
      path.join(cacheRoot, unrelatedIdentity, 'activation.json'),
      JSON.stringify({ active: buildId })
    )
    await writeFile(
      path.join(keypairRoot, 'orca-e2ee-keypair.json'),
      JSON.stringify({ publicKeyB64 })
    )
    const expectedHostRoot = path.join(cacheRoot, expectedIdentity)
    const activateExpectedHost = setTimeout(async () => {
      await mkdir(expectedHostRoot, { recursive: true })
      await writeFile(
        path.join(expectedHostRoot, 'activation.json'),
        JSON.stringify({ active: buildId })
      )
    }, 20)
    const runCommand = vi.fn().mockResolvedValue({ stdout: appDataPath })

    await expect(
      waitForHostedIosBuildActivation(
        'simulator',
        { expectedBuild: buildId, timeoutMs: 1_000 },
        runtimeDirectory,
        runCommand
      )
    ).resolves.toBeUndefined()
    clearTimeout(activateExpectedHost)
  })
})
