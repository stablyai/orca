import { afterEach, describe, expect, it } from 'vitest'
import { z } from 'zod'
import { closeProviderTimelineRigs } from '../native-chat/agent-session-timeline/provider-timeline-assembler-test-support'
import { HOST_TEST_SESSION as SESSION } from '../native-chat/agent-session-wire/structured-agent-session-host-test-data'
import { GENERIC_ACP_DIALECT } from './acp-dialects/acp-dialect'
import { OMP_ACP_DIALECT } from './acp-dialects/omp-dialect'
import { GROK, PROVIDER_SESSION, waitFor } from './acp-structured-adapter.test-support'
import { openAttachedHostRig, send } from './acp-structured-host.test-support'

afterEach(closeProviderTimelineRigs)

const OMP_LIKE = { ...GROK, dialect: OMP_ACP_DIALECT }
const sessionOf = (params: unknown) => z.object({ sessionId: z.string() }).parse(params).sessionId
const errorsOf = async (rig: Awaited<ReturnType<typeof openAttachedHostRig>>) =>
  (await rig.rows()).flatMap((row) =>
    row.body.kind === 'status' && row.body.tone === 'error' ? [row.body.text] : []
  )

// oh-my-pi acp-agent.ts #getSessionRecord and #runCancelCleanup reject prompts with these details.
describe.each([`Unsupported ACP session: ${PROVIDER_SESSION}`, 'ACP cancel cleanup timed out'])(
  'an OMP prompt answered %j',
  (details) => {
    it('fails the turn, replaces the child, and reopens the saved session for the next send', async () => {
      const rig = await openAttachedHostRig({ spec: OMP_LIKE })
      const { host } = rig
      const lost = rig.rig.child()
      await send(host, 'hello')
      const refused = await rig.rig.frame('session/prompt')
      lost.agent.fail(refused, -32603, 'Internal error', { details })
      await waitFor(() => expect(lost.exited).toBe(true))
      expect(await errorsOf(rig)).toEqual([details])

      await send(host, 'again')
      await waitFor(() => expect(rig.rig.child()).not.toBe(lost))
      const reopened = rig.rig.child()
      const prompt = await rig.rig.frame('session/prompt')
      expect(rig.count.loads).toBe(1)
      expect(sessionOf(prompt.params)).toBe(PROVIDER_SESSION)
      reopened.agent.reply(prompt, { stopReason: 'end_turn' })
      await waitFor(async () => expect(await rig.turns()).toHaveLength(2))
      expect((await rig.turns()).at(-1)?.state).toBe('completed')
      expect(await errorsOf(rig)).toEqual([details])
      await host.close(SESSION, 'user-close')
    })
  }
)

describe('a non-OMP ACP prompt answered with an unknown session', () => {
  it('fails only that turn and keeps its child', async () => {
    const rig = await openAttachedHostRig({ spec: { ...GROK, dialect: GENERIC_ACP_DIALECT } })
    const child = rig.rig.child()
    await send(rig.host, 'hello')
    const refused = await rig.rig.frame('session/prompt')
    child.agent.fail(refused, -32603, 'Internal error', {
      details: `Unsupported ACP session: ${PROVIDER_SESSION}`
    })
    await waitFor(async () => expect(await errorsOf(rig)).toHaveLength(1))
    await rig.rig.settle()
    expect(child.exited).toBe(false)
    await rig.host.close(SESSION, 'user-close')
  })
})
