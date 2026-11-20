import { describe, expect, it, vi } from 'vitest'
import type { BrowserClientHostCommandEvent } from '../../../../shared/browser/client-hosting/browser-client-host-protocol'
import type { BrowserClientAutomationResult } from '../../../../shared/browser/client-hosting/browser-client-automation-protocol'
import {
  REMOTE_RUNTIME_MAX_INBOUND_REQUEST_JSON_BYTES,
  REMOTE_RUNTIME_REQUEST_ENVELOPE_RESERVE_BYTES,
  serializeRemoteRuntimeRpcRequest
} from '../../../../shared/remote-runtime/remote-runtime-memory-limits'
import { createCommand } from '../../client-pages/execution/browser-client-page-command-executor-test-harness'
import { browserHostCommandResultIdentity } from './browser-host-command-result-submission'
import { stageBrowserHostCommandResult } from './browser-host-command-result-staging'

const screenshot = { type: 'automation', method: 'browser.screenshot', params: {} } as const
const identity = 'i'.repeat(256)
const largestIdentityCommand = createCommand('navigate', {
  authorityRuntimeId: identity,
  authorityEpoch: identity,
  browserHostClientId: identity,
  browserPageId: identity,
  commandId: identity,
  command: screenshot
})

function completed(valueBytes: number): BrowserClientAutomationResult {
  return { status: 'completed', value: 'x'.repeat(valueBytes - 2) }
}

function stage(
  command: BrowserClientHostCommandEvent,
  result: BrowserClientAutomationResult
): Promise<BrowserClientAutomationResult> {
  return stageBrowserHostCommandResult(command, result, vi.fn(), new AbortController().signal)
}

function commandResultRequestJson(
  command: BrowserClientHostCommandEvent,
  result: BrowserClientAutomationResult,
  deviceToken: string
): string {
  return serializeRemoteRuntimeRpcRequest({
    requestId: crypto.randomUUID(),
    deviceToken,
    method: 'browser.clientHost.commandResult',
    params: { ...browserHostCommandResultIdentity(command), result },
    maxBytes: REMOTE_RUNTIME_MAX_INBOUND_REQUEST_JSON_BYTES
  })
}

function largestUnstagedValueBytes(command: BrowserClientHostCommandEvent): number {
  return (
    REMOTE_RUNTIME_MAX_INBOUND_REQUEST_JSON_BYTES -
    REMOTE_RUNTIME_REQUEST_ENVELOPE_RESERVE_BYTES -
    JSON.stringify(browserHostCommandResultIdentity(command)).length
  )
}

describe('stageBrowserHostCommandResult for a host without staging', () => {
  it('sends the largest unstaged value but refuses one byte more', async () => {
    const limit = largestUnstagedValueBytes(largestIdentityCommand)
    const result = completed(limit)
    await expect(stage(largestIdentityCommand, result)).resolves.toBe(result)
    expect(() =>
      commandResultRequestJson(largestIdentityCommand, result, 't'.repeat(256))
    ).not.toThrow()
    await expect(stage(largestIdentityCommand, completed(limit + 1))).resolves.toMatchObject({
      status: 'failed',
      errorCode: 'browser_host_command_result_too_large'
    })
  })
})
