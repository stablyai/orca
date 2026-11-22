import { crc32 } from 'node:zlib'
import { afterEach, describe, expect, it } from 'vitest'
import type { AgentJournalRenderItem } from '../../../shared/agent-session/journal/agent-session-journal-types'
import { itemBlocks } from '../../../shared/agent-session/view/structured-agent-session-item-blocks'
import { nativeChatToolRunViewedImages } from '../../../shared/native-chat/tools/native-chat-tool-viewed-images'
import { closeProviderTimelineRigs } from '../../native-chat/agent-session-timeline/provider-timeline-assembler-test-support'
import { agentJournalItemForWire } from '../../native-chat/agent-session-wire/publication/history/agent-session-item-wire-form'
import { boundedFrameItem } from '../../native-chat/agent-session-wire/publication/history/agent-session-bounded-frame-item'
import { OPENCODE_ACP_DIALECT } from '../acp-dialects/opencode-dialect'
import type { SessionUpdate } from '../generated/acp-protocol.generated'
import { openAcpFixtureRig } from './testing/acp-timeline-fixture.test-support'

afterEach(closeProviderTimelineRigs)

const PIXEL =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+ip1sAAAAASUVORK5CYII='

// A valid PNG with an ancillary text chunk exercises bytes beyond the old 16 KiB frame head.
function annotatedPng(textBytes = 32 * 1024, insertAt = -12): string {
  const pixel = Buffer.from(PIXEL, 'base64')
  const text = Buffer.from(`Comment\0${'x'.repeat(textBytes)}`)
  const chunk = Buffer.alloc(text.length + 12)
  chunk.writeUInt32BE(text.length)
  chunk.write('tEXt', 4, 'ascii')
  text.copy(chunk, 8)
  chunk.writeUInt32BE(crc32(chunk.subarray(4, -4)), chunk.length - 4)
  return Buffer.concat([pixel.subarray(0, insertAt), chunk, pixel.subarray(insertAt)]).toString(
    'base64'
  )
}

function previews(rows: AgentJournalRenderItem[]) {
  return nativeChatToolRunViewedImages(
    rows.flatMap((row) => itemBlocks(agentJournalItemForWire(row).item)?.blocks ?? [])
  )
}

function update(fixture: Awaited<ReturnType<typeof openAcpFixtureRig>>, body: SessionUpdate) {
  fixture.apply(
    fixture.lane().notification('session/update', { sessionId: 'session-1', update: body }, 1_100)
  )
}

describe('ACP tool images', () => {
  it('retains captured pathless pixels on the tool through omitted completion and journal reopen', async () => {
    const fixture = await openAcpFixtureRig(OPENCODE_ACP_DIALECT, { journalOwnership: true })
    const data = annotatedPng()
    fixture.apply(fixture.lane().openPrompt('image-prompt', 1_000).events)
    update(fixture, {
      sessionUpdate: 'tool_call',
      toolCallId: 'image-only',
      title: 'Capture screenshot',
      name: 'screenshot',
      status: 'in_progress',
      content: [{ type: 'content', content: { type: 'image', mimeType: 'image/png', data } }]
    })
    update(fixture, {
      sessionUpdate: 'tool_call_update',
      toolCallId: 'image-only',
      status: 'completed'
    })
    fixture.apply(fixture.lane().promptResult('image-prompt', { stopReason: 'end_turn' }, 1_200))
    await fixture.rig.reopenJournal()

    const rows = await fixture.rig.rows()
    const tools = rows.filter((row) => row.body.kind === 'tool-call')
    expect(tools).toHaveLength(1)
    expect(tools[0]!.body).toMatchObject({
      kind: 'tool-call',
      callId: 'image-only',
      state: 'completed',
      outputImages: [{ type: 'image-ref', url: `data:image/png;base64,${data}` }]
    })
    expect(previews(rows)).toEqual([{ type: 'image-ref', url: `data:image/png;base64,${data}` }])
    expect(rows.filter((row) => row.body.kind === 'message')).toEqual([])
  })

  it('prefers replaced captured pixels per call while retaining legacy paths and replay ownership', async () => {
    const fixture = await openAcpFixtureRig(OPENCODE_ACP_DIALECT, { journalOwnership: true })
    fixture.apply(fixture.lane().openPrompt('first-prompt', 1_000).events)
    update(fixture, {
      sessionUpdate: 'tool_call',
      toolCallId: 'first-tool',
      title: 'Read diagram',
      name: 'read',
      rawInput: { path: '/images/changed.png' },
      status: 'in_progress',
      content: [{ type: 'content', content: { type: 'image', mimeType: 'image/png', data: PIXEL } }]
    })
    const data = annotatedPng()
    const completed: SessionUpdate = {
      sessionUpdate: 'tool_call_update',
      toolCallId: 'first-tool',
      status: 'completed',
      content: [
        { type: 'content', content: { type: 'text', text: 'Image read successfully' } },
        { type: 'content', content: { type: 'image', mimeType: 'image/png', data } },
        { type: 'diff', path: 'diagram.txt', oldText: 'before\n', newText: 'after\n' }
      ]
    }
    update(fixture, completed)
    update(fixture, completed)
    update(fixture, {
      sessionUpdate: 'tool_call',
      toolCallId: 'legacy-read',
      title: 'Read legacy image',
      name: 'read',
      rawInput: { path: '/images/legacy.png' },
      status: 'completed',
      content: [{ type: 'content', content: { type: 'text', text: 'Image read successfully' } }]
    })
    const original = (await fixture.rig.rows()).find(
      (row) => row.body.kind === 'tool-call' && row.body.callId === 'first-tool'
    )!
    expect(previews(await fixture.rig.rows())).toEqual([
      { type: 'image-ref', url: `data:image/png;base64,${data}` },
      { type: 'image-ref', path: '/images/legacy.png' }
    ])
    fixture.apply(fixture.lane().promptResult('first-prompt', { stopReason: 'end_turn' }, 1_200))
    await fixture.restart()
    fixture.apply(fixture.lane().openPrompt('second-prompt', 2_000).events)
    update(fixture, {
      sessionUpdate: 'tool_call',
      toolCallId: 'second-tool',
      title: 'Generate another diagram',
      name: 'generate_image',
      status: 'completed',
      content: [{ type: 'content', content: { type: 'image', mimeType: 'image/png', data } }]
    })
    update(fixture, completed)
    update(fixture, {
      sessionUpdate: 'tool_call_update',
      toolCallId: 'first-tool',
      status: 'completed'
    })

    const rows = await fixture.rig.rows()
    expect(previews(rows)).toEqual([
      { type: 'image-ref', url: `data:image/png;base64,${data}` },
      { type: 'image-ref', path: '/images/legacy.png' },
      { type: 'image-ref', url: `data:image/png;base64,${data}` }
    ])
    expect(rows.filter((row) => row.body.kind === 'message')).toEqual([])
    expect(rows.find((row) => row.itemId === original.itemId)).toMatchObject({
      body: original.body,
      turnScope: original.turnScope
    })
    expect(
      rows.find((row) => row.body.kind === 'tool-call' && row.body.callId === 'second-tool')
        ?.turnScope
    ).not.toEqual(original.turnScope)
    expect(
      rows.find((row) => row.body.kind === 'tool-call' && row.body.callId === 'first-tool')?.body
    ).toMatchObject({
      state: 'completed',
      output: { head: 'Image read successfully', truncated: false }
    })
    expect(rows.find((row) => row.body.kind === 'diff')?.body).toMatchObject({
      path: 'diagram.txt',
      patch: { head: expect.stringContaining('-before\n+after\n'), truncated: false }
    })
  })

  it('clears an explicit empty snapshot and falls back per call without relighting old pixels', async () => {
    const fixture = await openAcpFixtureRig(OPENCODE_ACP_DIALECT, { journalOwnership: true })
    fixture.apply(fixture.lane().openPrompt('clear-prompt', 1_000).events)
    update(fixture, {
      sessionUpdate: 'tool_call',
      toolCallId: 'clear-image',
      title: 'Read image',
      name: 'read',
      rawInput: { path: '/images/fallback.png' },
      status: 'in_progress',
      content: [{ type: 'content', content: { type: 'image', mimeType: 'image/png', data: PIXEL } }]
    })
    expect(previews(await fixture.rig.rows())).toEqual([
      { type: 'image-ref', url: `data:image/png;base64,${PIXEL}` }
    ])
    update(fixture, {
      sessionUpdate: 'tool_call_update',
      toolCallId: 'clear-image',
      status: 'in_progress',
      content: []
    })
    expect(previews(await fixture.rig.rows())).toEqual([])
    update(fixture, {
      sessionUpdate: 'tool_call_update',
      toolCallId: 'clear-image',
      status: 'completed'
    })
    update(fixture, {
      sessionUpdate: 'tool_call_update',
      toolCallId: 'clear-image',
      status: 'completed'
    })
    await fixture.rig.reopenJournal()
    const rows = await fixture.rig.rows()
    expect(rows.find((row) => row.body.kind === 'tool-call')?.body).toMatchObject({
      outputImages: []
    })
    expect(previews(rows)).toEqual([{ type: 'image-ref', path: '/images/fallback.png' }])
    expect(rows.filter((row) => row.body.kind === 'message')).toEqual([])
  })

  it('falls back when bounded publication clips captured pixels', async () => {
    const fixture = await openAcpFixtureRig(OPENCODE_ACP_DIALECT, { journalOwnership: true })
    // Place the annotation before IDAT so a clipped URI cannot even carry the original pixels.
    const data = annotatedPng(96 * 1024, 33)
    fixture.apply(fixture.lane().openPrompt('bounded-image-prompt', 1_000).events)
    update(fixture, {
      sessionUpdate: 'tool_call',
      toolCallId: 'large-read',
      title: 'Read image',
      name: 'read',
      rawInput: { path: '/images/capture.png' },
      status: 'completed',
      content: [{ type: 'content', content: { type: 'image', mimeType: 'image/png', data } }]
    })
    update(fixture, {
      sessionUpdate: 'tool_call',
      toolCallId: 'large-capture',
      title: 'Capture screenshot',
      name: 'screenshot',
      status: 'completed',
      content: [{ type: 'content', content: { type: 'image', mimeType: 'image/png', data } }]
    })
    update(fixture, {
      sessionUpdate: 'tool_call',
      toolCallId: 'small-capture',
      title: 'Capture small screenshot',
      name: 'screenshot',
      status: 'completed',
      content: [{ type: 'content', content: { type: 'image', mimeType: 'image/png', data: PIXEL } }]
    })
    await fixture.rig.reopenJournal()
    const rows = (await fixture.rig.rows()).filter((row) => row.body.kind === 'tool-call')
    const published = rows.map((row) => boundedFrameItem(agentJournalItemForWire(row)).item)
    expect(published.map((row) => row.shortened ?? false)).toEqual([true, true, false])
    expect(
      nativeChatToolRunViewedImages(published.flatMap((row) => itemBlocks(row)?.blocks ?? []))
    ).toEqual([
      { type: 'image-ref', path: '/images/capture.png' },
      { type: 'image-ref', alt: 'Image preview unavailable' },
      { type: 'image-ref', url: `data:image/png;base64,${PIXEL}` }
    ])
    expect(
      rows.flatMap((row) => (row.body.kind === 'tool-call' ? (row.body.outputImages ?? []) : []))
    ).toEqual([
      { type: 'image-ref', url: `data:image/png;base64,${data}` },
      { type: 'image-ref', url: `data:image/png;base64,${data}` },
      { type: 'image-ref', url: `data:image/png;base64,${PIXEL}` }
    ])
  })

  it('keeps unavailable image output as a label while allowing a successful read path fallback', async () => {
    const fixture = await openAcpFixtureRig(OPENCODE_ACP_DIALECT, { journalOwnership: true })
    fixture.apply(fixture.lane().openPrompt('invalid-prompt', 1_000).events)
    update(fixture, {
      sessionUpdate: 'tool_call',
      toolCallId: 'invalid-image',
      title: 'Capture image',
      name: 'screenshot',
      status: 'completed',
      content: [
        { type: 'content', content: { type: 'image', mimeType: 'image/png', data: '!bad!' } }
      ]
    })
    update(fixture, {
      sessionUpdate: 'tool_call',
      toolCallId: 'invalid-read',
      title: 'Read image',
      name: 'read',
      rawInput: { path: '/images/retained.png' },
      status: 'completed',
      content: [{ type: 'content', content: { type: 'image', mimeType: 'image/png', data: '' } }]
    })
    update(fixture, {
      sessionUpdate: 'tool_call',
      toolCallId: 'failed-read',
      title: 'Read missing image',
      name: 'read',
      rawInput: { path: '/images/missing.png' },
      status: 'failed',
      content: [{ type: 'content', content: { type: 'text', text: 'File not found' } }]
    })
    await fixture.rig.reopenJournal()
    const rows = await fixture.rig.rows()
    expect(previews(rows)).toEqual([
      { type: 'image-ref', alt: 'Image preview unavailable' },
      { type: 'image-ref', path: '/images/retained.png' }
    ])
    expect(rows.filter((row) => row.body.kind === 'message')).toEqual([])
  })
})
