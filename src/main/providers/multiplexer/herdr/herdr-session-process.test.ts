import { describe, expect, it } from 'vitest'
import { herdrServerEnvironment, parseHerdrSessionList } from './herdr-cli-session'

describe('stock Herdr session process', () => {
  it('does not inherit a caller pane or socket when starting a server', () => {
    const env = herdrServerEnvironment({
      PATH: '/bin',
      HERDR_ENV: '1',
      HERDR_SOCKET_PATH: '/tmp/caller.sock',
      HERDR_PANE_ID: 'w1:p1'
    })
    expect(env).toMatchObject({ PATH: '/bin' })
    expect(env.HERDR_SESSION).toBeUndefined()
    expect(env.HERDR_ENV).toBeUndefined()
    expect(env.HERDR_SOCKET_PATH).toBeUndefined()
    expect(env.HERDR_PANE_ID).toBeUndefined()
  })

  it('reads stock session-list JSON', () => {
    expect(
      parseHerdrSessionList(
        JSON.stringify({
          sessions: [
            { name: 'default', running: false },
            { name: 'orca-project', running: true }
          ]
        })
      )
    ).toEqual([
      { name: 'default', running: false },
      { name: 'orca-project', running: true }
    ])
  })
})
