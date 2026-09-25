import { afterAll, describe, expect, it, vi } from 'vitest'

// Live end-to-end for the relay `lsp.*` channel (ticket 17): deploys a real
// relay to an SSH host, spawns clangd via `lsp.spawn`, writes an LSP
// `initialize` request via `lsp.write`, and asserts a real LSP result streams
// back as `lsp.data`. Skipped unless ORCA_LIVE_SSH_HOST is set; never runs in
// normal CI or unit-test loops. Mirrors ssh-relay-live-connect.test.ts.
vi.mock('electron', () => ({
  app: { getAppPath: () => process.cwd() }
}))

import { SshChannelMultiplexer } from './ssh-channel-multiplexer'
import { SshConnection } from './ssh-connection'
import { resolveSshConfigHomePath } from './ssh-config-path-expansion'
import { deployAndLaunchRelay } from './ssh-relay-deploy'
import { LSP_RELAY_METHODS, isLspMethodNotFoundError } from '../../shared/lsp-relay-channel'
import type { SshTarget } from '../../shared/ssh-types'

const LIVE_HOST = process.env.ORCA_LIVE_SSH_HOST
const LIVE_USER = process.env.ORCA_LIVE_SSH_USER ?? process.env.USERNAME ?? process.env.USER ?? ''
const LIVE_IDENTITY = resolveSshConfigHomePath(
  process.env.ORCA_LIVE_SSH_IDENTITY ?? '~/.ssh/id_ed25519'
)
const rawLivePort = process.env.ORCA_LIVE_SSH_PORT
const LIVE_PORT = rawLivePort ? Number.parseInt(rawLivePort, 10) : 22

const startedAt = Date.now()
function log(step: string): void {
  const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1)
  console.log(`[live-lsp +${elapsed}s] ${step}`)
}

describe.skipIf(!LIVE_HOST)('live relay lsp.* channel', () => {
  const cleanups: (() => Promise<void> | void)[] = []

  afterAll(async () => {
    for (const cleanup of cleanups.toReversed()) {
      try {
        await cleanup()
      } catch (err) {
        log(`cleanup error: ${err instanceof Error ? err.message : String(err)}`)
      }
    }
  })

  it(
    'deploys the relay, lsp.spawn clangd, streams a real LSP initialize result as lsp.data',
    { timeout: 360_000 },
    async () => {
      if (!Number.isInteger(LIVE_PORT) || LIVE_PORT < 1 || LIVE_PORT > 65535) {
        throw new Error(`Invalid ORCA_LIVE_SSH_PORT: ${rawLivePort}`)
      }

      const target: SshTarget = {
        id: 'live-lsp-harness',
        label: 'live-lsp-harness',
        host: LIVE_HOST!,
        port: LIVE_PORT,
        username: LIVE_USER,
        identityFile: LIVE_IDENTITY,
        source: 'manual'
      }

      log(`connecting to ${LIVE_USER}@${LIVE_HOST}:${LIVE_PORT}`)
      const conn = new SshConnection(target, {
        onStateChange: (_id, state) => {
          log(`state=${state.status}${state.error ? ` error=${state.error}` : ''}`)
        }
      })
      cleanups.push(() => conn.disconnect())
      await conn.connect()
      log('ssh connection established')

      const deployed = await deployAndLaunchRelay(
        conn,
        (status) => log(`deploy: ${status}`),
        30,
        'live-lsp-harness'
      )
      log(`relay launched (remoteRelayDir=${deployed.remoteRelayDir})`)

      const mux = new SshChannelMultiplexer(deployed.transport)
      cleanups.push(() => mux.dispose())

      // Subscribe to lsp.data BEFORE spawning so no frame is lost.
      const dataChunks: Buffer[] = []
      const unsubscribeData = mux.onNotificationByMethod(LSP_RELAY_METHODS.data, (params) => {
        if (typeof params.data === 'string') {
          dataChunks.push(Buffer.from(params.data, 'base64'))
          // Ack every frame to release the relay's credit window.
          mux.notify(LSP_RELAY_METHODS.ack, {
            sessionId: params.sessionId,
            seq: params.seq
          })
        }
      })
      cleanups.push(() => unsubscribeData())

      let exitSeen = false
      const unsubscribeExit = mux.onNotificationByMethod(LSP_RELAY_METHODS.exit, () => {
        exitSeen = true
      })
      cleanups.push(() => unsubscribeExit())

      // Capability probe + spawn. An old relay answers method_not_found — the
      // test asserts that path degrades rather than hangs.
      let spawnResult: { sessionId?: string } | null
      try {
        spawnResult = (await mux.request(LSP_RELAY_METHODS.spawn, {
          program: 'clangd',
          args: ['--log=verbose']
        })) as { sessionId?: string } | null
      } catch (err) {
        if (isLspMethodNotFoundError(err)) {
          log('relay does not support lsp.* (too old) — graceful degradation confirmed')
          return
        }
        throw err
      }
      const sessionId = spawnResult?.sessionId
      expect(sessionId).toBeTruthy()
      log(`lsp.spawn -> sessionId=${sessionId}`)

      // Write a minimal LSP initialize request (Content-Length framed, base64).
      const initRequest = {
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          processId: process.pid,
          rootUri: null,
          capabilities: { general: { positionEncodings: ['utf-16'] } }
        }
      }
      const body = Buffer.from(JSON.stringify(initRequest), 'utf8')
      const frame = Buffer.concat([
        Buffer.from(`Content-Length: ${body.length}\r\n\r\n`, 'utf8'),
        body
      ])
      mux.notify(LSP_RELAY_METHODS.write, {
        sessionId,
        data: frame.toString('base64')
      })
      log('lsp.write initialize request sent')

      // clangd initialize ~100ms; preamble build can take longer. Poll up to 8s.
      const deadline = Date.now() + 8_000
      let reassembled = ''
      while (Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 200))
        reassembled = Buffer.concat(dataChunks).toString('utf8')
        if (reassembled.includes('"result"')) {
          break
        }
      }
      log(`received ${dataChunks.length} lsp.data frames (${reassembled.length} bytes)`)
      expect(reassembled).toContain('Content-Length:')
      expect(reassembled).toContain('"result"')
      expect(reassembled).toMatch(/capabilities|positionEncoding/)

      // Kill clangd; assert host-acknowledged lsp.exit.
      await mux.request(LSP_RELAY_METHODS.kill, { sessionId })
      const exitDeadline = Date.now() + 3_000
      while (Date.now() < exitDeadline && !exitSeen) {
        await new Promise((resolve) => setTimeout(resolve, 100))
      }
      expect(exitSeen).toBe(true)
      log('lsp.kill + lsp.exit ok: full relay lsp.* round-trip verified')
    }
  )
})
