// One runtime RPC over a persistent paired connection (the desktop's request lane), headless.
//   ORCA_PAIRING_CODE=<code> <repo>/node_modules/.bin/tsx desktop/runtime-rpc.ts <method> '<json params>' [repeat=1]
// Prints one JSON line: {ms: number[], response} (response of the last call).
import { ELECTRON_REMOTE_RUNTIME_CLIENT_CAPABILITIES } from '../../../../src/shared/electron-remote-runtime-client-capabilities'
import { pairedRuntimeConnectionFromOffer } from '../../../../src/shared/remote-runtime/pairing/paired-runtime-connection'
import { parsePairingCode } from '../../../../src/shared/remote-runtime/pairing/pairing'
import { RemoteRuntimeRequestConnection } from '../../../../src/shared/remote-runtime/requests/remote-runtime-request-connection'

const [method, paramsJson, repeat] = process.argv.slice(2) as [string, string, string | undefined]
const pairing = process.env.ORCA_PAIRING_CODE
if (!pairing) {
  throw new Error('ORCA_PAIRING_CODE required')
}
const connection = new RemoteRuntimeRequestConnection(pairedRuntimeConnectionFromOffer(parsePairingCode(pairing)!), ELECTRON_REMOTE_RUNTIME_CLIENT_CAPABILITIES)
const ms: number[] = []
let response: unknown = null
try {
  for (let i = 0; i < Number(repeat ?? 1); i++) {
    const t0 = performance.now()
    response = await connection.request(method, JSON.parse(paramsJson), 60_000)
    ms.push(Math.round(performance.now() - t0))
  }
  console.log(JSON.stringify({ ms, response }))
} catch (error) {
  console.log(JSON.stringify({ ms, error: String(error instanceof Error ? error.message : error).slice(0, 300) }))
}
process.exit(0)
