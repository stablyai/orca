import { afterEach, expect, it, vi } from 'vitest'
import {
  closeProviderTimelineRigs,
  SESSION
} from '../native-chat/agent-session-timeline/provider-timeline-assembler-test-support'
import { AgentSessionAcquisitionRootExitObservedError } from '../native-chat/agent-session-wire/structured-agent-session-adapter'
import { promptIdOf } from './acp-structured-host.test-support'
import { openAcpAdapterRig, replyChunk, sendHello } from './acp-structured-adapter.test-support'

afterEach(async () => {
  vi.restoreAllMocks()
  await closeProviderTimelineRigs()
})

it.each(['delivered', 'root-exited', 'unproven', 'error'] as const)(
  'owns detached lane/sink cleanup with old raw-stop outcome parity: %s',
  async (outcome) => {
    const entries =
      outcome === 'error'
        ? ['raw-stop', 'sink-refusal', 'sink-without-logger']
        : ['raw-stop', 'sink-refusal']
    for (const entry of entries) {
      const fallback = entry === 'sink-without-logger'
      const warn = fallback ? vi.spyOn(console, 'warn').mockImplementation(() => {}) : null
      const logger = { warn: vi.fn(), error: vi.fn() }
      const rig = await openAcpAdapterRig({ deps: fallback ? {} : { logger } })
      let refuse = false
      const append = rig.rig.eventSink.tryAppendTransition!
      vi.spyOn(rig.rig.eventSink, 'tryAppendTransition').mockImplementation((transition) =>
        refuse ? { accepted: false, reason: 'closed' } : append(transition)
      )
      await rig.acquire()
      const child = rig.child()
      const terminal = outcome === 'delivered' || outcome === 'root-exited'
      Object.defineProperty(child, 'lastCloseResult', {
        value: {
          root: outcome === 'root-exited' ? 'exited' : 'live',
          tree: 'unverifiable',
          ...(outcome === 'delivered' ? { killDelivered: true } : {})
        }
      })
      const failure = new Error('genuine cleanup failure')
      child.proveClose = vi.fn(async () => {
        if (outcome === 'error') {
          throw failure
        }
        if (outcome === 'root-exited') {
          child.processTreeUnproven = true
          child.exit()
        }
        return terminal
      })
      if (entry === 'raw-stop') {
        if (outcome === 'error') {
          await expect(rig.adapter['children'].stop(SESSION, false)).rejects.toBe(failure)
        } else {
          expect(await rig.adapter['children'].stop(SESSION, false)).toBe(terminal)
        }
      } else {
        const sending = sendHello(rig, 'sink-failure').catch(() => undefined)
        const frame = await rig.frame('session/prompt')
        refuse = true
        child.agent.notify(
          'session/update',
          replyChunk(promptIdOf(frame), 'output that cannot be journaled')
        )
        await vi.waitFor(() => expect(child.proveClose).toHaveBeenCalled())
        await rig.settle()
        await sending
        if (outcome === 'error' && fallback) {
          expect(warn).toHaveBeenCalledWith(
            expect.stringContaining('acp-child-cleanup'),
            expect.objectContaining({ error: failure })
          )
        } else if (outcome === 'error') {
          expect(logger.warn).toHaveBeenCalledWith(
            'ACP failed-child cleanup failed',
            expect.objectContaining({ error: failure })
          )
        } else {
          expect(logger.warn).not.toHaveBeenCalledWith(
            'ACP failed-child cleanup failed',
            expect.anything()
          )
        }
      }
      expect(rig.ended).toHaveLength(terminal ? 1 : 0)
      if (outcome === 'delivered') {
        expect(rig.ended[0]).toMatchObject({ deathEvidenceKind: 'kill-delivered' })
      }
      if (terminal) {
        await rig.acquire({ fence: 2 })
        expect(rig.spawned.filter((value) => value === 'spawn')).toHaveLength(2)
      }
      child.proveClose = async () => {
        child.exit()
        return true
      }
      await rig.adapter.closeAll()
    }
  }
)

it('keeps joined force-close typed delivery evidence', async () => {
  const rig = await openAcpAdapterRig()
  await rig.acquire()
  Object.defineProperty(rig.child(), 'lastCloseResult', {
    value: { root: 'live', tree: 'unverifiable', killDelivered: true }
  })
  rig.child().proveClose = async () => true
  await expect(rig.adapter.forceCloseSession(SESSION)).rejects.toBeInstanceOf(
    AgentSessionAcquisitionRootExitObservedError
  )
})
