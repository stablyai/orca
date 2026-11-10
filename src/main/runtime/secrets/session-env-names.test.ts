import { describe, expect, it } from 'vitest'
import { readSessionEnvNames } from './session-env-names'

describe('readSessionEnvNames', () => {
  it('reads names (never values) from the session env file', async () => {
    const paths: string[] = []
    const names = await readSessionEnvNames({
      uid: 1000,
      read: async (path) => {
        paths.push(path)
        return 'STRIPE_KEY=c2VjcmV0\nDB_URL=\nnot a line\nlower=eA==\n'
      },
      env: { FROM_PROCESS: '1' }
    })
    expect(paths).toEqual(['/dev/shm/orca-env-1000/session.env'])
    expect([...names]).toEqual(['STRIPE_KEY', 'DB_URL'])
  })

  it("falls back to the process env when there's no session env file", async () => {
    const names = await readSessionEnvNames({
      uid: 1000,
      read: async () => {
        throw Object.assign(new Error('missing'), { code: 'ENOENT' })
      },
      env: { FROM_PROCESS: '1' }
    })
    expect([...names]).toEqual(['FROM_PROCESS'])
  })
})
