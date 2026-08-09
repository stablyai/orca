import { existsSync } from 'node:fs'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { DebugAdapterEventMessage } from '../../shared/debug-session-types'
import { DapClient } from './dap-client'
import { DebugSessionStateMachine } from './debug-session-state-machine'
import {
  resolveDapDebugServerEntrypoint,
  resolveJsDebugAdapterRoot
} from './js-debug-adapter-bundle'
import { LocalJsDebugAdapterProcessHost } from './js-debug-adapter-process-host'
import { createNodeLaunchScriptConfig } from './js-debug-launch-config-templates'

const REPO_ROOT = join(import.meta.dirname, '..', '..', '..')
const BUNDLE_ROOT = resolveJsDebugAdapterRoot({
  isPackaged: false,
  resourcesPath: '/unused',
  appPath: REPO_ROOT
})
const BUNDLE_PRESENT = existsSync(resolveDapDebugServerEntrypoint(BUNDLE_ROOT))

// Why skip instead of fail: the real vscode-js-debug bundle is downloaded by
// `pnpm run ensure:debug-adapters` (not checked in — see
// config/scripts/vendor-js-debug-adapter.mjs) and isn't guaranteed present on
// a fresh checkout or in CI's fast test gate. This suite runs a real Node
// process through a real js-debug adapter end to end whenever the bundle
// happens to be there (e.g. after `pnpm dev`/`pnpm run
// ensure:debug-adapters` locally); js-debug-session-bridge.test.ts covers
// the same bridging logic against a fake adapter unconditionally.
describe.skipIf(!BUNDLE_PRESENT)('LocalJsDebugAdapterProcessHost (real vscode-js-debug)', () => {
  let workDir: string | undefined

  afterEach(async () => {
    if (workDir) {
      await rm(workDir, { recursive: true, force: true })
      workDir = undefined
    }
  })

  it('launches a real Node script (via createNodeLaunchScriptConfig) through LocalJsDebugAdapterProcessHost, hits a breakpoint, and reads a variable', async () => {
    workDir = await mkdtemp(join(tmpdir(), 'orca-js-debug-e2e-'))
    const scriptPath = join(workDir, 'target.js')
    await writeFile(
      scriptPath,
      ['let answer = 1', 'answer = 42', 'console.log(answer)', ''].join('\n')
    )

    // Exercises the same shape ipc/debug.ts's debug:start handler drives:
    // build a DebugAdapterConfig from a launch config template, spawn the
    // host with it, then run initialize/launch/configurationDone with
    // config.request/config.adapterArgs exactly as the IPC handler does.
    const config = createNodeLaunchScriptConfig({ program: scriptPath, cwd: workDir })

    const host = new LocalJsDebugAdapterProcessHost(undefined, {
      isPackaged: false,
      resourcesPath: '/unused',
      appPath: REPO_ROOT
    })
    const proc = await host.spawn(config)

    try {
      const client = new DapClient(proc.stdin, proc.stdout, proc.stderr)
      const machine = new DebugSessionStateMachine(client)

      const stopped = new Promise<DebugAdapterEventMessage>((resolve) => {
        machine.on('event', (msg: DebugAdapterEventMessage) => {
          if (msg.event === 'stopped') {
            resolve(msg)
          }
        })
      })

      await machine.initialize({
        adapterID: config.type,
        clientID: 'orca',
        linesStartAt1: true,
        columnsStartAt1: true,
        pathFormat: 'path'
      })
      await machine.launch({ request: config.request, args: config.adapterArgs ?? {} })
      await machine.setBreakpoints({
        source: { path: scriptPath },
        breakpoints: [{ line: 2 }]
      })
      await machine.configurationDone()

      const stoppedEvent = await stopped
      const threadId = (stoppedEvent.body as { threadId: number }).threadId

      const stackTrace = (await machine.getStackTrace(threadId)) as {
        stackFrames: { id: number; line: number }[]
      }
      expect(stackTrace.stackFrames[0]?.line).toBe(2)

      const scopes = (await client.request('scopes', {
        frameId: stackTrace.stackFrames[0]!.id
      })) as {
        scopes: { variablesReference: number }[]
      }
      const variables = (await machine.getVariables(scopes.scopes[0]!.variablesReference)) as {
        variables: { name: string; value: string }[]
      }
      expect(variables.variables.some((v) => v.name === 'answer' && v.value === '1')).toBe(true)

      await machine.continue(threadId)
      await machine.terminate()
    } finally {
      proc.kill()
    }
  }, 30_000)
})
