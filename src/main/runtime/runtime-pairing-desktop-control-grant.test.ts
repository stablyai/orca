import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { DeviceRegistry } from './device-registry'
import { OrcaRuntimeService } from './orca-runtime'
import { OrcaRuntimeRpcServer } from './runtime-rpc'
import { getServeOptions } from '../startup/serve-options'
import { parseArgs as parseOrcadArgs } from '../orcad/orcad-command-arguments'

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), 'orca-desktop-control-grant-'))
}

async function dispatchOverWebSocket(
  server: OrcaRuntimeRpcServer,
  deviceToken: string,
  method: string,
  params: unknown = { app: 'Finder' }
): Promise<Record<string, unknown>> {
  const replies: Record<string, unknown>[] = []
  await server['handleWebSocketMessage'](
    JSON.stringify({ id: `req-${method}`, method, deviceToken, params }),
    (response) => replies.push(JSON.parse(response)),
    () => {}
  )
  return replies[0] ?? {}
}

function errorCode(reply: Record<string, unknown>): unknown {
  const error = reply.error
  return typeof error === 'object' && error !== null && 'code' in error ? error.code : undefined
}

describe('desktop control for paired runtime clients', () => {
  it('is refused to a runtime pairing that did not grant it', async () => {
    const userDataPath = tempDir()
    const server = new OrcaRuntimeRpcServer({
      runtime: new OrcaRuntimeService(),
      userDataPath,
      enableWebSocket: false
    })
    server['deviceRegistry'] = new DeviceRegistry(userDataPath)
    const device = server['deviceRegistry']!.addDevice('laptop', 'runtime')
    const reply = await dispatchOverWebSocket(server, device.token, 'computer.click')
    expect(errorCode(reply)).toBe('forbidden')
  })

  it('passes the permission gate for a pairing created with the grant', async () => {
    const userDataPath = tempDir()
    const server = new OrcaRuntimeRpcServer({
      runtime: new OrcaRuntimeService(),
      userDataPath,
      enableWebSocket: false
    })
    server['deviceRegistry'] = new DeviceRegistry(userDataPath)
    const device = server['deviceRegistry']!.addDevice('laptop', 'runtime', 'network', [
      'desktop-control'
    ])
    const reply = await dispatchOverWebSocket(server, device.token, 'computer.click')
    expect(errorCode(reply)).not.toBe('forbidden')
  })
})

describe('pairing and push administration for paired runtime clients', () => {
  it.each<[string, unknown]>([
    ['pairing.provisionRelay', {}],
    ['notifications.registerPush', { token: 't', platform: 'ios' }]
  ])('refuses %s without reaching its service', async (method, params) => {
    const userDataPath = tempDir()
    const runtime = new OrcaRuntimeService()
    const server = new OrcaRuntimeRpcServer({ runtime, userDataPath, enableWebSocket: false })
    server['deviceRegistry'] = new DeviceRegistry(userDataPath)
    const device = server['deviceRegistry']!.addDevice('laptop', 'runtime')
    const registerPush = vi.spyOn(runtime, 'registerMobilePushDevice')
    const reply = await dispatchOverWebSocket(server, device.token, method, params)
    expect(errorCode(reply)).toBe('forbidden')
    expect(registerPush).not.toHaveBeenCalled()
  })
})

describe('pairing-time grants on the device registry', () => {
  it('persist across a reload and are dropped for mobile devices', () => {
    const userDataPath = tempDir()
    const registry = new DeviceRegistry(userDataPath)
    const runtime = registry.addDevice('laptop', 'runtime', 'network', ['desktop-control'])
    const phone = registry.addDevice('phone', 'mobile', 'network', ['desktop-control'])

    const reloaded = new DeviceRegistry(userDataPath)
    expect(reloaded.getDevice(runtime.deviceId)?.grants).toEqual(['desktop-control'])
    expect(reloaded.getDevice(phone.deviceId)?.grants).toBeUndefined()
  })

  it('never widen a pending offer that was advertised without them', () => {
    const registry = new DeviceRegistry(tempDir())
    const plain = registry.getOrCreatePendingDevice('cli', 'runtime')
    const granted = registry.getOrCreatePendingDevice('cli', 'runtime', 'network', [
      'desktop-control'
    ])
    expect(granted.token).not.toBe(plain.token)
    expect(registry.getDevice(plain.deviceId)?.grants).toBeUndefined()
    expect(registry.getOrCreatePendingDevice('cli', 'runtime').token).toBe(plain.token)
  })
})

describe('the --grant-desktop-control serve flag', () => {
  it('reaches the desktop serve options in both argv shapes', () => {
    expect(getServeOptions(['/AppRun', '--serve']).grantDesktopControl).toBe(false)
    expect(
      getServeOptions(['/AppRun', '--serve', '--serve-grant-desktop-control']).grantDesktopControl
    ).toBe(true)
    expect(() =>
      getServeOptions(['/AppRun', '--serve', '--grant-desktop-control', '--mobile-pairing'])
    ).toThrow('--grant-desktop-control applies only to the default runtime pairing offer.')
  })

  it('reaches orcad', () => {
    expect(parseOrcadArgs(['--grant-desktop-control'])).toEqual({ grantDesktopControl: true })
    expect(() => parseOrcadArgs(['--grant-desktop-control', '--no-pairing'])).toThrow(
      '--grant-desktop-control applies only to the default runtime pairing offer'
    )
  })
})
