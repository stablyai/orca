import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { parsePairingCode } from '../../../src/shared/pairing.ts'
import { pairedRuntimeConnectionFromOffer } from '../../../src/shared/paired-runtime-connection.ts'
import { RemoteRuntimeRequestConnection } from '../../../src/shared/remote-runtime/requests/remote-runtime-request-connection.ts'
import { checkDaemonHealthWithCoverage } from '../../../src/main/daemon/daemon-health.ts'
import { resolveDaemonUnixSocketPath } from '../../../src/main/daemon/daemon-socket-endpoint-path.ts'

async function main() {
  try {
    const ready = JSON.parse(await readFile('/run/orca/readiness.json', 'utf8'))
    const offer = ready.pairing?.available ? parsePairingCode(ready.pairing.url) : null
    if (!offer || ready.health?.terminalDaemon?.state !== 'live') {
      throw new Error('runtime or terminal daemon did not become ready')
    }
    const connection = new RemoteRuntimeRequestConnection({
      ...pairedRuntimeConnectionFromOffer(offer),
      endpoint: 'ws://127.0.0.1:6768'
    })
    try {
      const reply = await connection.request('status.get', null, 5000)
      if (!reply.ok) {
        throw new Error('authenticated runtime status failed')
      }
    } finally {
      connection.close()
    }
    const version = ready.health.terminalDaemon.protocolVersion
    const directory = join(process.env.ORCA_USER_DATA, 'daemon')
    const probe = await checkDaemonHealthWithCoverage(
      resolveDaemonUnixSocketPath(directory, `daemon-v${version}.sock`),
      join(directory, `daemon-v${version}.token`)
    )
    if (probe.verdict !== 'healthy' || probe.coverage !== 'pty-spawn') {
      throw new Error(`terminal daemon self-test: ${probe.verdict} (${probe.coverage})`)
    }
    console.log('authenticated RPC and terminal PTY healthy')
  } catch (error) {
    console.error(error.message)
    process.exitCode = 1
  }
}

main().catch((error) => {
  console.error(error.message)
  process.exitCode = 1
})
