import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  CROSS_MACHINE_RECOVERY_CLIENT_INSTANCE_FILE,
  readOrMintCrossMachineRecoveryClientInstanceId
} from './client-instance-id'

describe('readOrMintCrossMachineRecoveryClientInstanceId', () => {
  let stateDirectory: string

  beforeEach(async () => {
    stateDirectory = await mkdtemp(join(tmpdir(), 'orca-xmr-client-id-'))
  })
  afterEach(async () => {
    await rm(stateDirectory, { recursive: true, force: true })
  })

  it('mints once and returns the persisted id afterwards', async () => {
    const [first, concurrent] = await Promise.all([
      readOrMintCrossMachineRecoveryClientInstanceId(stateDirectory),
      readOrMintCrossMachineRecoveryClientInstanceId(stateDirectory)
    ])
    expect(concurrent).toBe(first)
    expect(await readOrMintCrossMachineRecoveryClientInstanceId(stateDirectory)).toBe(first)
    const stored = JSON.parse(
      await readFile(join(stateDirectory, CROSS_MACHINE_RECOVERY_CLIENT_INSTANCE_FILE), 'utf8')
    )
    expect(stored).toEqual({ clientInstanceId: first })
  })

  it('replaces a corrupt file with a fresh id', async () => {
    await writeFile(join(stateDirectory, CROSS_MACHINE_RECOVERY_CLIENT_INSTANCE_FILE), '{nope')
    const minted = await readOrMintCrossMachineRecoveryClientInstanceId(stateDirectory)
    expect(minted).toMatch(/^[0-9a-f-]{36}$/)
    expect(await readOrMintCrossMachineRecoveryClientInstanceId(stateDirectory)).toBe(minted)
  })
})
