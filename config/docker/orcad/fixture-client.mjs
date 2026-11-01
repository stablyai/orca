import assert from 'node:assert/strict'
import { readFile, writeFile } from 'node:fs/promises'
import { parsePairingCode } from '../../../src/shared/pairing.ts'
import { pairedRuntimeConnectionFromOffer } from '../../../src/shared/paired-runtime-connection.ts'
import { RemoteRuntimeRequestConnection } from '../../../src/shared/remote-runtime/requests/remote-runtime-request-connection.ts'

async function main() {
  const [pairingFile, statusFile] = process.argv.slice(2)
  const offer = parsePairingCode((await readFile(pairingFile, 'utf8')).trim())
  assert.ok(offer, 'fixture pairing offer is invalid')
  const connection = new RemoteRuntimeRequestConnection(pairedRuntimeConnectionFromOffer(offer))
  try {
    const response = await connection.request('status.get', null, 10000)
    assert.equal(response.ok, true)
    assert.ok(response.result.runtimeId)
    assert.ok(response.result.pairedDeviceId)
    const summary = {
      runtimeId: response.result.runtimeId,
      pairedDeviceId: response.result.pairedDeviceId,
      appVersion: response.result.appVersion,
      protocolVersion: response.result.protocolVersion
    }
    if (process.argv.includes('--create')) {
      await writeFile(statusFile, JSON.stringify(summary))
    } else {
      const previous = JSON.parse(await readFile(statusFile, 'utf8'))
      assert.equal(summary.pairedDeviceId, previous.pairedDeviceId)
    }
    console.log(JSON.stringify(summary))
  } finally {
    connection.close()
  }
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
