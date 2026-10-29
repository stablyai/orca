import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  readOrcadHostAccountLaunchEnv,
  restoreOrcadHostAccountLaunchEnv
} from './orcad-host-account-launch-env-store'
import { RuntimeAccountController } from '../runtime/runtime-account-controller'

const dirs: string[] = []
function userData(): string {
  const dir = mkdtempSync(join(tmpdir(), 'orcad-host-accounts-'))
  dirs.push(dir)
  return dir
}

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true })
  }
})

describe('orcad host account launch env store', () => {
  it('reads nothing from a missing, corrupt or unsafe file', () => {
    const dir = userData()
    expect(readOrcadHostAccountLaunchEnv(dir)).toBeNull()
    writeFileSync(join(dir, 'host-account-launch-env.json'), '{not json')
    expect(readOrcadHostAccountLaunchEnv(dir)).toBeNull()
    writeFileSync(
      join(dir, 'host-account-launch-env.json'),
      JSON.stringify({ wslDistro: 'Ubuntu', claude: { PATH: '/evil' }, terminal: {} })
    )
    expect(readOrcadHostAccountLaunchEnv(dir)).toBeNull()
  })

  it("holds a fresh WSL host's first agent launch for the desktop's push, and nowhere else", async () => {
    for (const isWslHost of [true, false]) {
      const accounts = new RuntimeAccountController()
      restoreOrcadHostAccountLaunchEnv(
        { restoreHostAccountLaunchEnv: accounts.restoreHostLaunchEnv.bind(accounts) },
        userData(),
        () => isWslHost
      )
      let launched = false
      void accounts.prepareHostAgentLaunch(null).then(() => {
        launched = true
      })
      await Promise.resolve()
      await Promise.resolve()
      expect(launched).toBe(!isWslHost)
      accounts.setHostLaunchEnv({ wslDistro: 'Ubuntu', claude: {}, terminal: {} })
    }
  })
})
