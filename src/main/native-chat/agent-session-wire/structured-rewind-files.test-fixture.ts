import { recoverStructuredRewind } from './structured-rewind-recovery'
import { createPatch } from 'diff'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { expect, it, type Mock } from 'vitest'
import { AGENT_JOURNAL_THREAD_SCOPE } from '../../../shared/agent-session-journal-types'
import type { AgentSessionRewindParams } from '../../../shared/agent-session-rewind'
import { computeAgentSessionPayloadFingerprint } from '../../../shared/agent-session-mutation-envelope'
import type { StructuredAgentSessionHost } from './structured-agent-session-host'
import type { StructuredAgentSessionEventSink } from './structured-agent-session-event-sink'
import type { StructuredAgentSessionAdapter } from './structured-agent-session-adapter'
import { HOST_TEST_SESSION, HOST_TEST_THREAD } from './structured-agent-session-host-test-data'

const caller = { callerKey: 'desktop' }

export function registerRewindFileTests(
  rig: () => {
    host: StructuredAgentSessionHost
    directory: string
    sink: StructuredAgentSessionEventSink
    rewind: Mock<NonNullable<StructuredAgentSessionAdapter['rewind']>>
  },
  {
    seed,
    params
  }: { seed: () => Promise<string>; params: (target: string) => Promise<AgentSessionRewindParams> }
) {
  async function fileRewindRequest(target: string) {
    const { host, directory, sink } = rig()
    host.deps.resolveWorkspacePath = async () => directory
    const patch = createPatch('example.txt', 'before\n', 'after\n')
    await writeFile(join(directory, 'example.txt'), 'after\n')
    sink.appendItem(
      { provider: 'codex', threadId: HOST_TEST_THREAD, turnId: 'tip', ordinal: 1 },
      {
        kind: 'diff',
        state: 'completed',
        path: 'example.txt',
        patch: { head: patch, byteLength: patch.length, digest: '', truncated: false }
      },
      { turnScope: AGENT_JOURNAL_THREAD_SCOPE }
    )
    await host.flushStreamedEvents(HOST_TEST_SESSION)
    const request = await params(target)
    const preview = await host.previewRewindFiles({
      sessionId: HOST_TEST_SESSION,
      itemId: target,
      expectedEpoch: request.expectedEpoch
    })
    expect(preview.available).toBe(true)
    if (!preview.available) {
      throw new Error(preview.reason)
    }
    const fields = {
      itemId: target,
      expectedEpoch: request.expectedEpoch,
      mode: 'conversation-and-files' as const,
      filesFingerprint: preview.fingerprint
    }
    return {
      ...fields,
      envelope: {
        ...request.envelope,
        payloadFingerprint: computeAgentSessionPayloadFingerprint({
          method: 'agentSession.rewind',
          sessionId: HOST_TEST_SESSION,
          fields
        })
      }
    }
  }

  it('rewinds recorded files together with the conversation and replays without writing again', async () => {
    const { host, directory } = rig()
    const request = await fileRewindRequest(await seed())
    expect(await host.rewind(caller, request)).toMatchObject({ ok: true })
    expect(await readFile(join(directory, 'example.txt'), 'utf8')).toBe('before\n')
    await writeFile(join(directory, 'example.txt'), 'later edit\n')
    expect(await host.rewind(caller, request)).toMatchObject({ ok: true })
    expect(await readFile(join(directory, 'example.txt'), 'utf8')).toBe('later edit\n')
  })

  it('keeps both files and conversation when files conflict after the preview', async () => {
    const { host, directory, rewind } = rig()
    const request = await fileRewindRequest(await seed())
    const before = await host.journalSnapshot(HOST_TEST_SESSION)
    await writeFile(join(directory, 'example.txt'), 'other agent\n')
    expect(await host.rewind(caller, request)).toMatchObject({ ok: false })
    expect(rewind).not.toHaveBeenCalled()
    expect((await host.journalSnapshot(HOST_TEST_SESSION)).items).toEqual(before.items)
    expect(await readFile(join(directory, 'example.txt'), 'utf8')).toBe('other agent\n')
  })

  it('restores the original files when the provider refuses the conversation rewind', async () => {
    const { host, directory, rewind } = rig()
    const request = await fileRewindRequest(await seed())
    rewind.mockResolvedValueOnce({ ok: false, reason: 'provider-refused' })
    expect(await host.rewind(caller, request)).toMatchObject({ ok: false })
    expect(await readFile(join(directory, 'example.txt'), 'utf8')).toBe('after\n')
  })
  it('recovers an uncertain provider reply without undoing a later external edit twice', async () => {
    const { host, directory, rewind } = rig()
    const request = await fileRewindRequest(await seed())
    rewind.mockRejectedValueOnce(new Error('reply lost'))
    await expect(host.rewind(caller, request)).rejects.toThrow('reply lost')
    expect(await readFile(join(directory, 'example.txt'), 'utf8')).toBe('before\n')
    await writeFile(join(directory, 'example.txt'), 'other agent after rewind\n')
    const journal = host.collaboratorsForTests().sessions.get(HOST_TEST_SESSION)!.journal
    await recoverStructuredRewind(
      host.deps,
      HOST_TEST_SESSION,
      journal,
      host.deps.store.getRecord(HOST_TEST_SESSION)!.lease.runtimeFence,
      host.deps.adapter
    )
    expect(host.deps.store.getRecord(HOST_TEST_SESSION)?.rewind?.phase).toBe('completed')
    expect(await readFile(join(directory, 'example.txt'), 'utf8')).toBe(
      'other agent after rewind\n'
    )
  })
}
