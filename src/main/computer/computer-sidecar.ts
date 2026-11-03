import { computerProviderUnavailableMessage } from './computer-provider-unavailable-message'
import { currentComputerProvider, shutdownComputerProviders } from './computer-provider-lifecycle'
import { RuntimeClientError } from './runtime-client-error'
import { ComputerTreeBaselines } from './computer-snapshot-tree-diff'
import type { ComputerProviderCapabilities } from '../../shared/runtime-types'

type SidecarRequest = {
  id: number
  method: string
  params?: Record<string, unknown>
}

// Handle IPC disconnect too: Windows SIGTERM does not run JavaScript signal handlers.
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

const treeBaselines = new ComputerTreeBaselines()

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
  const provider = currentComputerProvider()
  if (!provider) {
    throw new RuntimeClientError(
      'unsupported_capability',
      computerProviderUnavailableMessage(process.platform)
    )
  }

  switch (method) {
    case 'capabilities': {
      return withTreeDiffCapability(await provider.capabilities())
    }
    case 'listApps': {
      return await provider.listApps()
    }
    case 'listWindows': {
      return await provider.listWindows(params)
    }
    case 'getAppState': {
      return treeBaselines.apply(params, await provider.snapshot(params))
    }
    case 'click': {
      return treeBaselines.apply(params, await provider.action('click', params))
    }
    case 'performSecondaryAction': {
      return treeBaselines.apply(params, await provider.action('performSecondaryAction', params))
    }
    case 'scroll': {
      return treeBaselines.apply(params, await provider.action('scroll', params))
    }
    case 'drag': {
      return treeBaselines.apply(params, await provider.action('drag', params))
    }
    case 'typeText': {
      return treeBaselines.apply(params, await provider.action('typeText', params))
    }
    case 'pressKey': {
      return treeBaselines.apply(params, await provider.action('pressKey', params))
    }
    case 'hotkey': {
      return treeBaselines.apply(params, await provider.action('hotkey', params))
    }
    case 'pasteText': {
      return treeBaselines.apply(params, await provider.action('pasteText', params))
    }
    case 'setValue': {
      return treeBaselines.apply(params, await provider.action('setValue', params))
    }
    default:
      throw new RuntimeClientError(
        'invalid_argument',
        `unknown computer sidecar method '${method}'`
      )
  }
}

function withTreeDiffCapability(
  capabilities: ComputerProviderCapabilities
): ComputerProviderCapabilities {
  const { supports } = capabilities
  return {
    ...capabilities,
    supports: { ...supports, observation: { ...supports.observation, treeDiff: true } }
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
  shutdownComputerProviders()
}
