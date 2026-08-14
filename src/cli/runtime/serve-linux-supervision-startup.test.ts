import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { SERVE_SUPERVISOR_ENV } from '../../shared/serve-supervision'
import { prepareLinuxServeSupervision } from './serve-linux-supervision-startup'

describe('Linux serve supervision startup', () => {
  const roots: string[] = []

  afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
  })

  it('reconciles before marking a child as supervised', async () => {
    const root = await mkdtemp(join(tmpdir(), 'orca-serve-supervision-'))
    roots.push(root)
    const childEnv: NodeJS.ProcessEnv = {}

    await prepareLinuxServeSupervision(join(root, 'missing-profile'), root, childEnv)

    expect(childEnv[SERVE_SUPERVISOR_ENV]).toBe('1')
  })
})
