import { describe, expect, it } from 'vitest'
import {
  createPowerShellRunner,
  getWindowsDefaultRouteInterfaceNames
} from './windows-default-route-interfaces'

// zh-CN default Ethernet alias and a Hyper-V External Switch named in Chinese.
const ALIASES = ['以太网', 'vEthernet (新建虚拟交换机)']

describe('getWindowsDefaultRouteInterfaceNames', () => {
  it.skipIf(process.platform !== 'win32')(
    'round-trips non-ASCII adapter aliases through Windows PowerShell 5.1',
    async () => {
      const run = createPowerShellRunner(process.env.SystemRoot)
      let originalScript = ''
      let fixedScript = ''
      const names = await getWindowsDefaultRouteInterfaceNames({
        platform: 'win32',
        // Real script and runner, with only the live route query swapped for fixed aliases.
        runPowerShell: (script) => {
          originalScript = script
          fixedScript = script.replace(
            /^\$names = @\(Get-NetRoute.*$/m,
            `$names = @(${ALIASES.map((alias) => `'${alias}'`).join(', ')})`
          )
          // Cold CI PowerShell starts can exceed the 3 s production limit.
          return run(fixedScript, 30_000)
        }
      })
      expect(fixedScript).not.toBe(originalScript)
      expect(names && [...names]).toEqual(ALIASES)
    },
    40_000
  )
})
