import { readFileSync } from 'node:fs'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { AcpStructuredOptions } from '../../../acp/acp-structured-options'
import { NewSessionResponseSchema } from '../../../acp/generated/acp-protocol.generated'
import { DESKTOP_RENDERER_RUNTIME_CLIENT_CAPABILITIES } from '../../../ipc/desktop-renderer-runtime-capabilities'
import { ELECTRON_REMOTE_RUNTIME_CLIENT_CAPABILITIES } from '../../../../shared/electron-remote-runtime-client-capabilities'
import { AGENT_SESSION_OPTIONAL_MODEL_CLIENT_CAPABILITY } from '../../../../shared/agent-session-optional-model-capability'
import { remoteRuntimeClientCapabilities } from '../../../../shared/remote-runtime-client-capabilities'
import { parseRuntimeClientCapabilities } from '../runtime-client-capabilities'
import {
  call,
  clearStructuredHostStub,
  hostCalls,
  installStructuredHostStub,
  SESSION,
  STRUCTURED_CLIENT
} from './structured-agent-session-rpc.test-fixture'

const CURRENT_CLIENT = {
  ...STRUCTURED_CLIENT,
  clientCapabilities: [
    ...STRUCTURED_CLIENT.clientCapabilities,
    AGENT_SESSION_OPTIONAL_MODEL_CLIENT_CAPABILITY
  ]
}
const DESKTOP_CLIENTS = [
  ['local desktop', [...DESKTOP_RENDERER_RUNTIME_CLIENT_CAPABILITIES]],
  ['paired desktop', remoteRuntimeClientCapabilities(ELECTRON_REMOTE_RUNTIME_CLIENT_CAPABILITIES)]
] as const

function missingModelReport() {
  const reader = new AcpStructuredOptions()
  reader.adoptSession(
    NewSessionResponseSchema.parse(
      JSON.parse(
        readFileSync(
          new URL('../../../acp/fixtures/omp-v17-windows-new-no-model.json', import.meta.url),
          'utf8'
        )
      )
    )
  )
  return reader.read()
}

beforeEach(installStructuredHostStub)
afterEach(clearStructuredHostStub)

describe('options without a selected model across client versions', () => {
  it.each(['runtime', 'mobile'] as const)(
    'refuses the captured model-less report for an older %s client',
    async (clientKind) => {
      hostCalls.readOptions.mockResolvedValue(missingModelReport())
      const reply = await call(
        'agentSession.options',
        { sessionId: SESSION },
        {
          ...STRUCTURED_CLIENT,
          clientKind
        }
      )
      expect(reply).toMatchObject({
        ok: false,
        error: { message: 'structured_agent_session_unsupported' }
      })
      expect(reply).not.toHaveProperty('result')
      expect(hostCalls.readOptions).toHaveBeenCalledTimes(1)
    }
  )

  it.each(DESKTOP_CLIENTS)(
    'returns the captured absence to the %s',
    async (_name, capabilities) => {
      const report = missingModelReport()
      hostCalls.readOptions.mockResolvedValue(report)
      const reply = await call(
        'agentSession.options',
        { sessionId: SESSION },
        {
          clientKind: 'runtime',
          clientCapabilities: [...capabilities]
        }
      )
      expect(reply).toMatchObject({ id: 'request-1', ok: true, result: report })
      if (!reply.ok) {
        throw new Error('Updated desktops must receive the report')
      }
      expect(reply.result).toEqual(report)
      expect(reply).not.toHaveProperty('result.current.model')
    }
  )

  it('keeps same-build in-process reads available', async () => {
    const report = missingModelReport()
    hostCalls.readOptions.mockResolvedValue(report)
    expect(await call('agentSession.options', { sessionId: SESSION })).toMatchObject({
      ok: true,
      result: report
    })
  })

  it.each(['reported-model', ''])(
    'preserves an existing string-valued report (%j)',
    async (model) => {
      const report = { models: [], current: { model, effort: 'off' } }
      hostCalls.readOptions.mockResolvedValue(report)
      for (const client of [STRUCTURED_CLIENT, CURRENT_CLIENT]) {
        expect(await call('agentSession.options', { sessionId: SESSION }, client)).toMatchObject({
          ok: true,
          result: report
        })
      }
    }
  )

  it('resumes legacy discovery after the provider reports a model', async () => {
    hostCalls.readOptions.mockResolvedValueOnce(missingModelReport())
    expect(
      await call('agentSession.options', { sessionId: SESSION }, STRUCTURED_CLIENT)
    ).toMatchObject({
      ok: false
    })
    const report = { models: [], current: { model: 'later-model', effort: 'off' } }
    hostCalls.readOptions.mockResolvedValueOnce(report)
    expect(
      await call('agentSession.options', { sessionId: SESSION }, STRUCTURED_CLIENT)
    ).toMatchObject({
      ok: true,
      result: report
    })
  })

  it('keeps authenticated capability input compatible with older parsers', () => {
    for (const [, capabilities] of DESKTOP_CLIENTS) {
      expect(parseRuntimeClientCapabilities(capabilities)).toEqual(capabilities)
      expect(capabilities).toContain(AGENT_SESSION_OPTIONAL_MODEL_CLIENT_CAPABILITY)
    }
    expect(remoteRuntimeClientCapabilities()).not.toContain(
      AGENT_SESSION_OPTIONAL_MODEL_CLIENT_CAPABILITY
    )
  })
})
