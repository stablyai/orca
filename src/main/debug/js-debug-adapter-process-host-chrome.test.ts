import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { DapClient } from './dap-client'
import { DebugSessionStateMachine } from './debug-session-state-machine'
import {
  resolveDapDebugServerEntrypoint,
  resolveJsDebugAdapterRoot
} from './js-debug-adapter-bundle'
import { LocalJsDebugAdapterProcessHost } from './js-debug-adapter-process-host'
import { createChromeLaunchUrlConfig } from './js-debug-launch-config-templates'

const REPO_ROOT = join(import.meta.dirname, '..', '..', '..')
const BUNDLE_ROOT = resolveJsDebugAdapterRoot({
  isPackaged: false,
  resourcesPath: '/unused',
  appPath: REPO_ROOT
})
const BUNDLE_PRESENT = existsSync(resolveDapDebugServerEntrypoint(BUNDLE_ROOT))

// Why skip instead of fail: same reasoning as js-debug-adapter-process-host.test.ts
// (real bundle isn't checked in), plus this additionally needs a real Chrome
// install, which isn't guaranteed on every dev machine or CI runner.
describe.skipIf(!BUNDLE_PRESENT)(
  'LocalJsDebugAdapterProcessHost (real vscode-js-debug, Chrome)',
  () => {
    it('launches real headless Chrome and evaluates an expression through the cascaded child session', async () => {
      const config = createChromeLaunchUrlConfig({ url: 'about:blank' })
      config.adapterArgs = {
        ...config.adapterArgs,
        runtimeArgs: ['--headless=new', '--disable-gpu']
      }

      const host = new LocalJsDebugAdapterProcessHost(undefined, {
        isPackaged: false,
        resourcesPath: '/unused',
        appPath: REPO_ROOT
      })
      const proc = await host.spawn(config)

      try {
        const client = new DapClient(proc.stdin, proc.stdout, proc.stderr)
        const machine = new DebugSessionStateMachine(client)

        await machine.initialize({
          adapterID: config.type,
          clientID: 'orca',
          linesStartAt1: true,
          columnsStartAt1: true,
          pathFormat: 'path'
        })
        await machine.launch({ request: config.request, args: config.adapterArgs ?? {} })
        await machine.configurationDone()

        const result = (await machine.evaluate({ expression: '1 + 1', context: 'repl' })) as {
          result: string
        }
        expect(result.result).toBe('2')

        await machine.terminate()
      } finally {
        proc.kill()
      }
    }, 30_000)
  }
)
