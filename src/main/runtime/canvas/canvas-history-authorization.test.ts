import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { OrcaRuntimeService } from '../orca-runtime'
import { OrcaRuntimeRpcServer } from '../runtime-rpc'
import { DeviceRegistry } from '../device-registry'
import { OrchestrationDb } from '../orchestration/db'
import { stopCanvasMessaging } from './canvas-messaging-runtime'

it('permits history for a paired runtime owner without agent credentials and denies mobile scope', async () => {
  const userDataPath = mkdtempSync(join(tmpdir(), 'orca-canvas-history-'))
  const runtime = new OrcaRuntimeService()
  const db = new OrchestrationDb(':memory:')
  runtime.setOrchestrationDb(db)
  const server = new OrcaRuntimeRpcServer({ runtime, userDataPath, enableWebSocket: false })
  const devices = new DeviceRegistry(userDataPath)
  server['deviceRegistry'] = devices
  const owner = devices.addDevice('desktop', 'runtime')
  const mobile = devices.addDevice('phone', 'mobile')
  const history = async (token?: string) => {
    const replies: unknown[] = []
    await server['handleWebSocketMessage'](
      JSON.stringify({ id: 'history', method: 'canvas.history', params: { canvasId: 'canvas' } }),
      (response) => replies.push(JSON.parse(response)),
      () => {},
      undefined,
      undefined,
      token
    )
    return replies[0]
  }
  try {
    expect(await history()).toMatchObject({ ok: false, error: { code: 'unauthorized' } })
    expect(await history('invalid')).toMatchObject({ ok: false, error: { code: 'unauthorized' } })
    expect(await history(mobile.token)).toMatchObject({ ok: false, error: { code: 'forbidden' } })
    expect(await history(owner.token)).toMatchObject({ ok: true, result: { messages: [] } })
  } finally {
    stopCanvasMessaging(runtime)
    await server.stop()
    db.close()
    rmSync(userDataPath, { recursive: true, force: true })
  }
})
