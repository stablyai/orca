import { describe, expect, it, vi } from 'vitest'
import type { MobileWebBridgeClient } from '../../../src/mobile-web/src/mobile-web-bridge-client'
import { webHostScreenShellOperations } from './web-host-screen-shell-operations'

describe('web host screen shell operations', () => {
  it('keeps internal routes page-local and sends only named shell intents', async () => {
    const openExternal = vi.fn().mockResolvedValue(null)
    const client = {
      native: { openExternal },
      navigationRoute: vi.fn().mockResolvedValue(null),
      navigationReconnect: vi.fn().mockResolvedValue(null),
      navigationRemoveHost: vi.fn().mockResolvedValue(null)
    } as unknown as MobileWebBridgeClient
    const navigate = vi.fn()
    const operations = webHostScreenShellOperations(client, navigate)

    operations.navigateFromHostList('/h/opaque-host/tasks')
    operations.leaveHost()
    operations.repairPairing()
    operations.openConnectionDiagnostics()
    await operations.openExternalUrl('https://example.com/source')
    await operations.reconnect()
    await operations.removeHost('native-public-key-must-not-cross')

    expect(navigate).toHaveBeenCalledWith('/h/opaque-host/tasks')
    expect(client.navigationRoute).toHaveBeenNthCalledWith(1, { destination: 'hostPicker' })
    expect(client.navigationRoute).toHaveBeenNthCalledWith(2, { destination: 'pairingRepair' })
    expect(client.navigationRoute).toHaveBeenNthCalledWith(3, { destination: 'connectionLog' })
    expect(openExternal).toHaveBeenCalledWith('https://example.com/source')
    expect(client.navigationReconnect).toHaveBeenCalledWith()
    expect(client.navigationRemoveHost).toHaveBeenCalledWith({
      confirmation: 'remove-paired-host'
    })
    expect(JSON.stringify(vi.mocked(client.navigationRemoveHost).mock.calls)).not.toContain(
      'native-public-key'
    )
  })

  it('fails closed before the native shell initializes', async () => {
    const operations = webHostScreenShellOperations(null, vi.fn())

    await expect(operations.openExternalUrl('https://example.com')).rejects.toThrow(
      'Native shell channel unavailable'
    )
    await expect(operations.reconnect()).rejects.toThrow('Native shell channel unavailable')
    await expect(operations.removeHost('')).rejects.toThrow('Native shell channel unavailable')
  })
})
