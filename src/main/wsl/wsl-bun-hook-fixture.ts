import { bunOwnedRuntimeArgs } from '../../shared/bun-owned-runtime-args'
import assert from 'node:assert/strict'
import { once } from 'node:events'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { spawnProcess } from '../../shared/child-process/run-process'
import { buildWslExecArgs } from '../../shared/wsl-login-shell-command'
import { AGENT_HOOK_NOTIFICATION_METHOD } from '../../shared/agent-hook-relay'
import {
  WSL_HOOK_FS_METHODS,
  wslHookRelayEndpointFilePath
} from '../../shared/wsl-hook-relay-contract'
import { buildGuestInstallScript } from '../agent-hooks/wsl-hook-relay-launch'
import { waitForWslRelaySentinel } from '../agent-hooks/wsl-hook-relay-sentinel'
import { SshChannelMultiplexer } from '../ssh/ssh-channel-multiplexer'
import { resolveWslExecutablePath } from './wsl-executable-path'
import type { WslSpec } from './wsl-runner'

export async function verifyWslBunHookRelay(options: {
  distro: string
  home: string
  executable: string
  run: (spec: WslSpec) => Promise<string>
}): Promise<void> {
  const { distro, home, executable, run } = options
  const version = 'runtime-qualification'
  const instance = 'runtime-test'
  const token = 'isolated-runtime-test'
  const bundle = await readFile(join(process.cwd(), 'out/relay/wsl/wsl-agent-hook-relay.js'))
  await run({ script: buildGuestInstallScript(bundle, version), loginPath: 'none' })
  const child = spawnProcess({
    program: resolveWslExecutablePath(),
    args: buildWslExecArgs(distro, [
      'env',
      `HOME=${home}`,
      'ORCA_AGENT_HOOK_PORT=57891',
      `ORCA_AGENT_HOOK_TOKEN=${token}`,
      `ORCA_WSL_HOOK_INSTANCE=${instance}`,
      `ORCA_WSL_HOOK_RELAY_VERSION=${version}`,
      'sh',
      `${home}/.orca-wsl/hook-relay/bun/${version}/launch.sh`,
      executable
    ]),
    env: { ORCA_BACKGROUND_LAUNCH: '1', WSL_UTF8: '1' }
  })
  const closed = once(child, 'close', { signal: AbortSignal.timeout(20_000) })
  void closed.catch(() => {})
  let mux: SshChannelMultiplexer | undefined
  try {
    mux = new SshChannelMultiplexer(await waitForWslRelaySentinel(child))
    const information = await mux.request(WSL_HOOK_FS_METHODS.home)
    assert(information && typeof information === 'object' && 'home' in information)
    assert.equal(information.home, home)
    const endpoint = await run({
      program: 'cat',
      args: [wslHookRelayEndpointFilePath(home, instance)],
      loginPath: 'none'
    })
    const port = Number(/ORCA_AGENT_HOOK_PORT=['"]?(\d+)/.exec(endpoint)?.[1])
    assert(Number.isInteger(port) && port > 0)
    const paneKey = 'runtime-tab:11111111-1111-4111-8111-111111111111'
    const received = new Promise<Record<string, unknown>>((resolve) => {
      mux?.onNotificationByMethod(AGENT_HOOK_NOTIFICATION_METHOD, resolve)
    })
    const body = {
      paneKey,
      tabId: 'runtime-tab',
      worktreeId: 'runtime-folder',
      env: 'remote',
      version: '1',
      payload: { hook_event_name: 'UserPromptSubmit', prompt: 'WSL Bun hook round trip' }
    }
    const status = await run({
      program: executable,
      args: [
        ...bunOwnedRuntimeArgs('linux'),
        '-e',
        `const response = await fetch('http://127.0.0.1:${port}/hook/claude', {
        method: 'POST', headers: {'Content-Type':'application/json','X-Orca-Agent-Hook-Token':${JSON.stringify(token)}},
        body: ${JSON.stringify(JSON.stringify(body))}
      }); console.log(response.status); await response.arrayBuffer();`
      ],
      loginPath: 'none'
    })
    assert.equal(status, '204')
    const envelope = await Promise.race([
      received,
      closed.then(() => {
        throw new Error('Hook relay closed before delivering the envelope')
      })
    ])
    assert.equal(envelope.paneKey, paneKey)
  } finally {
    mux?.dispose()
    child.stdin.end()
    try {
      await closed
    } finally {
      child.kill()
    }
  }
}
