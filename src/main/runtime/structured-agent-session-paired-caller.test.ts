// A paired device's socket carries its bearer credential as `clientId`. Native chat keys
// operations, records and prompt answers by caller, and keeps them on disk, so the credential
// must never become that key.

import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { RpcContext } from './rpc/core'
import { structuredCallerFor } from './rpc/methods/structured-agent-session-gate'
import { stopStructuredAgentSessionRuntime } from './structured-agent-session-runtime'
import {
  openStructuredCodexRpcHarness,
  type StructuredCodexRpcHarness
} from './structured-codex-session-rpc-test-harness'

const CREDENTIAL = 'paired-bearer-credential-0f3c9a71'
const DEVICE = 'device-7d2e41'

function context(fields: Partial<RpcContext>): RpcContext {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the caller key reads only identity fields.
  return { ...fields } as RpcContext
}

async function filesUnder(root: string): Promise<string[]> {
  const entries = await readdir(root, { recursive: true, withFileTypes: true })
  return entries
    .filter((entry) => entry.isFile())
    .map((entry) => join(entry.parentPath, entry.name))
}

describe('structuredCallerFor', () => {
  it('names a paired device by its device id on every dispatch path', () => {
    // The unary path stamps only `caller`; the streaming path also passes `pairedDeviceId`.
    const caller = { kind: 'paired-device' as const, deviceId: DEVICE }
    expect(structuredCallerFor(context({ clientId: CREDENTIAL, caller }))).toEqual({
      callerKey: DEVICE
    })
    expect(
      structuredCallerFor(context({ clientId: CREDENTIAL, pairedDeviceId: DEVICE, caller }))
    ).toEqual({ callerKey: DEVICE })
  })

  it('keeps the namespace of callers that hold no credential', () => {
    expect(
      structuredCallerFor(context({ clientId: 'desktop-renderer', caller: { kind: 'desktop' } }))
    ).toEqual({ callerKey: 'desktop-renderer' })
    expect(structuredCallerFor(context({ caller: { kind: 'local-cli' } }))).toEqual({
      callerKey: 'trusted-local:runtime'
    })
  })
})

describe('a paired device driving a structured chat', () => {
  let harness: StructuredCodexRpcHarness | undefined

  afterEach(async () => {
    await harness?.dispose()
    harness = undefined
  })

  it('stores its device id and never its credential', async () => {
    harness = await openStructuredCodexRpcHarness(undefined, {
      clientId: CREDENTIAL,
      pairedDeviceId: DEVICE
    })
    const created = await harness.ok<{ fence: number }>(
      'agentSession.create',
      harness.createIntentParams()
    )
    const body = {
      kind: 'message' as const,
      role: 'user' as const,
      blocks: [{ type: 'text' as const, text: 'hello from the phone' }]
    }
    await harness.ok('agentSession.send', {
      envelope: harness.envelope('agentSession.send', { body }, created.fence),
      body
    })
    await vi.waitFor(() =>
      expect(harness?.codex.live().calls.some((entry) => entry.method === 'turn/start')).toBe(true)
    )
    // Closes the databases, so every committed byte is in the files read below.
    await stopStructuredAgentSessionRuntime()

    const stored = await Promise.all((await filesUnder(harness.root)).map((file) => readFile(file)))
    expect(stored.filter((bytes) => bytes.includes(CREDENTIAL))).toHaveLength(0)
    expect(stored.some((bytes) => bytes.includes(DEVICE))).toBe(true)
  })
})
