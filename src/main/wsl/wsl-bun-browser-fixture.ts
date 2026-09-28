import { bunOwnedRuntimeArgs } from '../../shared/bun-owned-runtime-args'
import { once } from 'node:events'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import assert from 'node:assert/strict'
import { spawnProcess } from '../../shared/child-process/run-process'
import { waitForPromiseWithSignal } from '../../shared/abort-signal-reason'
import { buildWslExecArgs } from '../../shared/wsl-login-shell-command'
import { resolveWslBrowserNetworkExecutionRoute } from '../browser/wsl-browser-network-execution-route'
import { buildWslBrowserNetworkGuestInstallScript } from '../browser/wsl-browser-network-relay-launch'
import { resolveWslExecutablePath } from './wsl-executable-path'
import type { WslSpec } from './wsl-runner'

export async function verifyWslBunBrowserRelay(options: {
  distro: string
  home: string
  executable: string
  run: (spec: WslSpec) => Promise<string>
}): Promise<void> {
  const { distro, home, executable, run } = options
  const version = 'runtime-qualification'
  const bundle = await readFile(join(process.cwd(), 'out/relay/wsl/wsl-browser-network-relay.js'))
  await run({
    script: buildWslBrowserNetworkGuestInstallScript(bundle, version),
    loginPath: 'none'
  })
  const spawnGuest = (args: string[]) =>
    spawnProcess({
      program: resolveWslExecutablePath(),
      args: buildWslExecArgs(distro, ['env', `HOME=${home}`, ...args]),
      env: { ORCA_BACKGROUND_LAUNCH: '1', WSL_UTF8: '1' }
    })
  const echo = spawnGuest([
    executable,
    ...bunOwnedRuntimeArgs('linux'),
    '-e',
    `
    const net = require('node:net');
    const server = net.createServer(socket => {
      socket.on('error', error => { if(error.code !== 'ECONNRESET') throw error; });
      socket.pipe(socket);
    });
    server.listen(0, '127.0.0.1', () => console.log(server.address().port));
    process.stdin.resume();
    process.stdin.on('end', () => { server.close(); process.stdin.destroy(); });
  `
  ])
  echo.stderr.resume()
  const timeout = AbortSignal.timeout(15_000)
  const echoClosed = once(echo, 'close', { signal: timeout })
  void echoClosed.catch(() => {})
  const lines = createInterface({ input: echo.stdout })
  try {
    const [line] = await once(lines, 'line', { signal: timeout })
    const port = Number(line)
    assert(Number.isInteger(port) && port > 0, 'Guest echo server did not report its port')
    const relay = spawnGuest([
      'sh',
      `${home}/.orca-wsl/browser-network/bun/${version}/launch.sh`,
      executable
    ])
    relay.stderr.resume()
    const relayClosed = once(relay, 'close', { signal: timeout })
    void relayClosed.catch(() => {})
    const route = await resolveWslBrowserNetworkExecutionRoute(
      {
        executionHost: { kind: 'wsl', runtimeId: 'test-runtime', revision: 1, distro },
        runtimeId: 'test-runtime',
        runtimeRevision: 1
      },
      { launchRelay: async () => relay }
    )
    try {
      const socket = route.connect({ host: '127.0.0.1', port })
      const received = new Promise<Uint8Array>((resolve, reject) => {
        socket.on('error', reject)
        socket.on('data', resolve)
        socket.on('connect', () => socket.write(Buffer.from('Windows to WSL Bun browser relay')))
      })
      const bytes = await waitForPromiseWithSignal(received, timeout)
      assert.equal(Buffer.from(bytes).toString(), 'Windows to WSL Bun browser relay')
      socket.destroy()
    } finally {
      await route.close()
      await relayClosed
    }
  } finally {
    lines.close()
    echo.stdin.end()
    try {
      await echoClosed
    } finally {
      echo.kill()
    }
  }
}
