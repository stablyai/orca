import { describe, expect, it, vi } from 'vitest'
import {
  answerCodexAppServer,
  createMockDiscoveryChild
} from '../execution/commit-message-text-generation-test-harness'
import { discoverModelsLocal } from './commit-message-model-discovery'

const secret = 'synthetic-orca-gateway-value'
const headerSecret = 'synthetic-x-api-key-value'
const header = `Authorization: Bearer ignored\nX-Api-Key: ${headerSecret}`

function echoedOutput(): string {
  return `${secret}\nANTHROPIC_CUSTOM_HEADERS=${header}\n`
}

function absent(value: string): void {
  expect(value).not.toContain(secret)
  expect(value).not.toContain(headerSecret)
  expect(value).not.toContain('X-Api-Key')
  expect(value).not.toContain('ORCA_GATEWAY_VALUE')
}

describe('model discovery output boundary', () => {
  it('returns only the exit code when a local or WSL probe exits 1', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      for (const wslDistro of [undefined, 'Debian']) {
        const child = createMockDiscoveryChild()
        const pending = discoverModelsLocal({
          agentId: 'claude',
          env: { ORCA_GATEWAY_VALUE: secret, ANTHROPIC_CUSTOM_HEADERS: header },
          options: wslDistro ? { wslDistro } : {},
          backslash: 'escape',
          spawnAgent: () => child
        })
        await Promise.resolve()
        child.stdout.write(echoedOutput())
        child.stderr.write(echoedOutput())
        child.emit('close', 1)
        const result = await pending
        const blob = `${JSON.stringify(result)}\n${JSON.stringify(errorSpy.mock.calls)}`
        expect(result).toMatchObject({ success: false })
        absent(blob)
        if (!result.success) {
          expect(result.error).toContain('exited with code 1')
        }
      }
    } finally {
      errorSpy.mockRestore()
    }
  })

  it('logs a launcher exception without its message', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      const result = await discoverModelsLocal({
        agentId: 'claude',
        env: {},
        options: {},
        backslash: 'escape',
        spawnAgent: () => {
          throw new Error(`launcher blew up ${secret}`)
        }
      })
      const blob = `${JSON.stringify(result)}\n${JSON.stringify(errorSpy.mock.calls)}`
      expect(result).toMatchObject({ success: false })
      absent(blob)
      expect(JSON.stringify(errorSpy.mock.calls)).toContain('Error')
    } finally {
      errorSpy.mockRestore()
    }
  })

  it('logs a Codex model/list rejection without its message', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const child = createMockDiscoveryChild()
    try {
      const pending = discoverModelsLocal({
        agentId: 'codex',
        env: {},
        options: {},
        backslash: 'escape',
        spawnAgent: () => {
          answerCodexAppServer(child, [{ rpcError: { code: -32000, message: secret } }])
          return child
        }
      })
      const result = await pending
      child.emit('exit', 1, null)
      child.emit('close', 1, null)
      const blob = `${JSON.stringify(result)}\n${JSON.stringify(errorSpy.mock.calls)}`
      expect(result).toMatchObject({ success: false })
      absent(blob)
      expect(JSON.stringify(errorSpy.mock.calls)).toContain('-32000')
    } finally {
      errorSpy.mockRestore()
    }
  })
})
