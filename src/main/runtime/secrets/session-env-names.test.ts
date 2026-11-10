import { describe, expect, it } from 'vitest'
import { isCloudWorkspaceOrcad, readSessionEnvNames } from './session-env-names'

describe('readSessionEnvNames', () => {
  it('reads names (never values) from the session env file', async () => {
    const paths: string[] = []
    const names = await readSessionEnvNames({
      uid: 1000,
      read: async (path) => {
        paths.push(path)
        return 'STRIPE_KEY=c2VjcmV0\nDB_URL=\nnot a line\nlower=eA==\n'
      }
    })
    expect(paths).toEqual(['/dev/shm/orca-env-1000/session.env'])
    expect([...names]).toEqual(['STRIPE_KEY', 'DB_URL'])
  })

  it("is empty when there's no session env file, never orcad's own env", async () => {
    const names = await readSessionEnvNames({
      uid: 1000,
      read: async () => {
        throw Object.assign(new Error('missing'), { code: 'ENOENT' })
      }
    })
    expect([...names]).toEqual([])
  })
})

describe('isCloudWorkspaceOrcad', () => {
  it('needs both the cloud flag and a sandbox id', () => {
    expect(isCloudWorkspaceOrcad({ ORCA_IS_CLOUD: '1', ORCA_SANDBOX_ID: 'sbx_1' })).toBe(true)
    expect(isCloudWorkspaceOrcad({ ORCA_IS_CLOUD: '1' })).toBe(false)
    expect(isCloudWorkspaceOrcad({ ORCA_SANDBOX_ID: 'sbx_1' })).toBe(false)
    expect(isCloudWorkspaceOrcad({})).toBe(false)
  })
})
