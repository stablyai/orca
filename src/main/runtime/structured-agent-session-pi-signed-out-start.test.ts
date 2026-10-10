// A message that starts a signed-out Pi reaches it once and is settled by Pi's own refusal; the
// start made for it is never replaced as a signed-out child, which would start Pi for it forever.

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { readWholeAgentSessionFailureFact } from '../../shared/agent-session-failure'
import {
  hostTestMessage,
  HOST_TEST_SESSION as SESSION
} from '../native-chat/agent-session-wire/structured-agent-session-host-test-data'
import { createTestParams } from '../native-chat/agent-session-wire/structured-agent-session-create-test-fixture'
import { createStructuredAgentSessionLogger } from '../native-chat/agent-session-wire/structured-agent-session-logger'
import { piScriptedChild } from '../pi/pi-scripted-child.test-fixture'
import {
  ensureStructuredAgentSessionHost,
  stopStructuredAgentSessionRuntime
} from './structured-agent-session-runtime'

let directory: string | undefined
let operations = 0
const operationId = () => `${Date.now()}-${(++operations).toString(16).padStart(32, '0')}`
const caller = { callerKey: 'pi-signed-out-start-test' }

afterEach(async () => {
  await stopStructuredAgentSessionRuntime()
  if (directory) {
    await rm(directory, { recursive: true, force: true })
    directory = undefined
  }
})

it('settles the first message of a signed-out Pi as not signed in, and starts Pi once', async () => {
  directory = await mkdtemp(join(tmpdir(), 'orca-pi-signed-out-'))
  const root = directory
  const script = piScriptedChild({ signedOut: true })
  const host = await ensureStructuredAgentSessionHost({
    logger: createStructuredAgentSessionLogger(),
    stateDirectory: root,
    hostId: 'local',
    claimKeyId: 'key-1',
    resolveWorkspacePath: async () => root,
    resolveClaudeAuthPolicy: () => ({ account: 'managed' }),
    resolveLaunchArgs: () => [],
    resolveEnvironment: async () => ({}),
    ...script.deps
  })
  const firstMessage = {
    clientMessageId: operationId(),
    body: hostTestMessage('hello, signed-out Pi')
  }
  // As a new chat sends its first message: the start is made for it.
  const params = createTestParams(firstMessage, {
    provider: 'pi',
    agent: 'pi',
    accountHome: { variable: 'PI_CODING_AGENT_DIR', path: root },
    location: {
      executionHostId: 'local',
      wslDistro: null,
      workspaceId: 'folder-1',
      workspaceKind: 'folder'
    }
  })
  params.envelope.clientOperationId = operationId()
  const created = await host.create(caller, params, { firstMessage })
  if (!created.ok) {
    throw new Error(JSON.stringify(created.refusal))
  }
  // Pi answers its start after the host has published it, as a real Pi does.
  await vi.waitFor(() =>
    expect(host.collaboratorsForTests().sessions.get(SESSION)?.child?.phase).toBe('starting')
  )
  await new Promise((resolve) => setTimeout(resolve, 50))
  script.releaseHandshake()
  const submission = async () => {
    await host.flushStreamedEvents(SESSION)
    return (await host.journalSnapshot(SESSION)).submissions.find(
      (entry) => entry.clientMessageId === firstMessage.clientMessageId
    )
  }

  await vi.waitFor(async () => expect((await submission())?.dispatchState).toBe('rejected'), {
    timeout: 5_000
  })
  expect(readWholeAgentSessionFailureFact((await submission())?.rejection)?.kind).toBe(
    'notSignedIn'
  )
  // Nothing starts Pi again for a message it already refused.
  await new Promise((resolve) => setTimeout(resolve, 500))
  expect(script.spawns()).toBe(1)
  expect(script.closes()).toBe(0)
  expect(new Set(script.prompts())).toEqual(new Set(['hello, signed-out Pi']))
})
