/* eslint-disable max-lines -- Why: sidecar dispatch keeps one method table shared across native providers. */
import {
  MacOSNativeProviderClient,
  shouldUseMacOSNativeProvider
} from './macos-native-provider-client'
import {
  DesktopScriptProviderClient,
  shouldUseDesktopScriptProvider
} from './desktop-script-provider-client'
import { RuntimeClientError } from './runtime-client-error'

type SidecarRequest = {
  id: number
  method: string
  params?: Record<string, unknown>
}

const nativeMacOSProvider = shouldUseMacOSNativeProvider() ? new MacOSNativeProviderClient() : null
const desktopScriptProvider = shouldUseDesktopScriptProvider()
  ? new DesktopScriptProviderClient()
  : null

process.once('disconnect', shutdownProviders)
process.once('SIGTERM', () => {
  shutdownProviders()
  process.exit(0)
})
process.once('SIGINT', () => {
  shutdownProviders()
  process.exit(130)
})
process.once('beforeExit', shutdownProviders)

process.on('message', (message: unknown) => {
  void handleMessage(message)
})

async function handleMessage(message: unknown): Promise<void> {
  if (!isRequest(message)) {
    return
  }

  try {
    const result = await dispatch(message.method, message.params ?? {})
    process.send?.({ id: message.id, ok: true, result })
  } catch (error) {
    const mapped = errorToResponse(error)
    process.send?.({ id: message.id, ok: false, error: mapped })
  }
}

async function dispatch(method: string, params: Record<string, unknown>): Promise<unknown> {
  const provider = nativeMacOSProvider ?? desktopScriptProvider
  if (!provider) {
    throw new RuntimeClientError(
      'unsupported_capability',
      `computer-use has no native provider for ${process.platform}`
    )
  }

  switch (method) {
    case 'capabilities': {
      return await provider.capabilities()
    }
    case 'listApps': {
      return await provider.listApps()
    }
    case 'listWindows': {
      return await provider.listWindows(params)
    }
    case 'getAppState': {
      return await provider.snapshot(params)
    }
    case 'click': {
      return await provider.action('click', params)
    }
    case 'performSecondaryAction': {
      return await provider.action('performSecondaryAction', params)
    }
    case 'scroll': {
      return await provider.action('scroll', params)
    }
    case 'drag': {
      return await provider.action('drag', params)
    }
    case 'typeText': {
      return await provider.action('typeText', params)
    }
    case 'pressKey': {
      return await provider.action('pressKey', params)
    }
    case 'hotkey': {
      return await provider.action('hotkey', params)
    }
    case 'pasteText': {
      return await provider.action('pasteText', params)
    }
    case 'setValue': {
      return await provider.action('setValue', params)
    }
    default:
      throw new RuntimeClientError(
        'invalid_argument',
        `unknown computer sidecar method '${method}'`
      )
  }
}

function isRequest(message: unknown): message is SidecarRequest {
  if (!message || typeof message !== 'object') {
    return false
  }
  const record = message as Record<string, unknown>
  return (
    typeof record.id === 'number' &&
    typeof record.method === 'string' &&
    (record.params === undefined || (typeof record.params === 'object' && record.params !== null))
  )
}

function errorToResponse(error: unknown): { code: string; message: string } {
  if (
    error instanceof Error &&
    'code' in error &&
    typeof (error as { code: unknown }).code === 'string'
  ) {
    return { code: (error as { code: string }).code, message: error.message }
  }
  return {
    code: 'accessibility_error',
    message: error instanceof Error ? error.message : String(error)
  }
}

function shutdownProviders(): void {
  nativeMacOSProvider?.shutdown()
}
