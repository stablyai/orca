// Grok signs in on the machine it runs on: on auth required, with the API key in its own launch
// environment, else the sign-in it already cached; with neither, the chat reports it signed out.

import { afterEach, describe, expect, it } from 'vitest'
import { z } from 'zod'
import { closeProviderTimelineRigs } from '../native-chat/agent-session-timeline/provider-timeline-assembler-test-support'
import { AgentSessionAcquisitionRefusal } from '../native-chat/agent-session-wire/structured-agent-session-adapter'
import type { AcpScriptedAgent } from './acp-scripted-agent.test-support'
import {
  GROK_CONFIG_OPTIONS,
  openAcpAdapterRig,
  PROVIDER_SESSION
} from './acp-structured-adapter.test-support'

afterEach(async () => {
  await closeProviderTimelineRigs()
})

const METHOD = z.object({ methodId: z.string() })

const BOTH = [
  { id: 'xai.api_key', name: 'API key' },
  { id: 'cached_token', name: 'Cached sign-in' }
]

/** Grok refuses to open a session until it is authenticated. */
function requiresSignIn(agent: AcpScriptedAgent): void {
  let signedIn = false
  agent.on('authenticate', (frame) => {
    signedIn = true
    agent.reply(frame, {})
  })
  const opens = (method: string, result: unknown) =>
    agent.on(method, (frame) =>
      signedIn ? agent.reply(frame, result) : agent.fail(frame, -32000, 'Authentication required')
    )
  opens('session/new', { sessionId: PROVIDER_SESSION, configOptions: GROK_CONFIG_OPTIONS })
  opens('session/load', { configOptions: GROK_CONFIG_OPTIONS })
}

async function signInWith(options: {
  env: Record<string, string>
  authMethods: { id: string; name: string }[]
  resume?: boolean
}) {
  const rig = await openAcpAdapterRig({
    launch: {
      env: options.env,
      ...(options.resume
        ? {
            resume: {
              sessionId: PROVIDER_SESSION,
              key: 'acp-key',
              mayBeUnsaved: () => false,
              unannouncedLosses: () => []
            }
          }
        : {})
    },
    initialize: { authMethods: options.authMethods },
    script: requiresSignIn
  })
  const acquired = await rig.acquire().catch((error: unknown) => error)
  const methods = rig.sent('authenticate').map((frame) => METHOD.parse(frame.params).methodId)
  return { rig, acquired, methods }
}

describe('Grok sign-in on its own machine', () => {
  it("uses the API key in Grok's launch environment when Grok offers that method", async () => {
    const { acquired, methods } = await signInWith({
      env: { XAI_API_KEY: 'xai-1' },
      authMethods: BOTH
    })
    expect(methods).toEqual(['xai.api_key'])
    expect(acquired).toMatchObject({ link: { origin: 'created' } })
  })

  it('uses the cached sign-in without a key, or when Grok does not offer the key method', async () => {
    const noKey = await signInWith({ env: {}, authMethods: BOTH })
    expect(noKey.methods).toEqual(['cached_token'])
    expect(noKey.acquired).toMatchObject({ link: { origin: 'created' } })
    const keyNotOffered = await signInWith({
      env: { XAI_API_KEY: 'xai-1' },
      authMethods: [{ id: 'cached_token', name: 'Cached sign-in' }]
    })
    expect(keyNotOffered.methods).toEqual(['cached_token'])
  })

  it('reports Grok signed out when it offers neither, sending no sign-in', async () => {
    const { acquired, methods } = await signInWith({
      env: { XAI_API_KEY: 'xai-1' },
      authMethods: [{ id: 'browser', name: 'Browser' }]
    })
    expect(methods).toEqual([])
    expect(acquired).toBeInstanceOf(AgentSessionAcquisitionRefusal)
    expect(acquired).toMatchObject({ reason: 'notSignedIn' })
  })

  it('signs in the same way when it reopens a saved session', async () => {
    const { rig, acquired, methods } = await signInWith({
      env: { XAI_API_KEY: 'xai-1' },
      authMethods: BOTH,
      resume: true
    })
    expect(methods).toEqual(['xai.api_key'])
    expect(acquired).toMatchObject({ link: { origin: 'resumed' } })
    expect(rig.sent('session/new')).toEqual([])
  })
})
