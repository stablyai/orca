import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, type Server } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { listLiveDaemonProtocols } from './daemon-generation-liveness'
import { getDaemonPidPath, getDaemonSocketPath, getDaemonTokenPath } from './daemon-spawner'

const servers: Server[] = []
let runtimeDir = ''

async function serveGeneration(protocolVersion: number): Promise<void> {
  const server = createServer()
  servers.push(server)
  await new Promise<void>((resolve) =>
    server.listen(getDaemonSocketPath(runtimeDir, protocolVersion), resolve)
  )
}

afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => new Promise((resolve) => s.close(resolve))))
  rmSync(runtimeDir, { recursive: true, force: true })
})

describe('live daemon generations', () => {
  it('names every answering generation, including one newer than this build knows', async () => {
    runtimeDir = mkdtempSync(join(tmpdir(), 'orca-generations-'))
    await serveGeneration(50)
    await serveGeneration(51)
    await serveGeneration(99)
    // A generation this build does not know is found by its token even while its pid record is absent.
    writeFileSync(getDaemonTokenPath(runtimeDir, 99), 'token')
    writeFileSync(getDaemonPidPath(runtimeDir, 49), JSON.stringify({ pid: 2 ** 22 + 1 }))
    // An answering endpoint counts even when its pid record is unreadable.
    writeFileSync(getDaemonPidPath(runtimeDir, 50), 'not a pid record')

    await expect(listLiveDaemonProtocols(runtimeDir, [49, 50, 51])).resolves.toEqual([50, 51, 99])
  })

  it('cannot vouch for a runtime dir it cannot list', async () => {
    runtimeDir = mkdtempSync(join(tmpdir(), 'orca-generations-'))
    // A file where the dir belongs fails the listing without depending on permissions.
    const notADir = join(runtimeDir, 'daemon')
    writeFileSync(notADir, '')

    await expect(listLiveDaemonProtocols(notADir, [51])).resolves.toBeNull()
  })
})
