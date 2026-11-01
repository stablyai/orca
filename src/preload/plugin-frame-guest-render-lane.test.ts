import { describe, expect, it } from 'vitest'
import { PLUGIN_DECLARATIVE_MESSAGES } from '../shared/plugins/declarative/plugin-declarative-message-names'
import { PLUGIN_DECLARATIVE_RENDER_LANE } from '../shared/plugins/declarative/plugin-declarative-limits'
import {
  createPluginFrameSendBudget,
  PRELOAD_PLUGIN_FRAME_LANES
} from './plugin-frame-guest-send-budget'

function chain(depth: number): unknown {
  let tree: unknown = { type: 'Text', key: '#0', props: {}, children: ['leaf'] }
  for (let level = 1; level < depth; level++) {
    tree = { type: 'Stack', key: '#0', props: {}, children: [tree] }
  }
  return tree
}

describe('guest preload render lane', () => {
  it("pins its written-out caps to the host's render lane", () => {
    const { render } = PRELOAD_PLUGIN_FRAME_LANES
    expect(render.events).toEqual([
      PLUGIN_DECLARATIVE_MESSAGES.render,
      PLUGIN_DECLARATIVE_MESSAGES.persist,
      PLUGIN_DECLARATIVE_MESSAGES.retain
    ])
    expect(render.maxBytes).toBe(PLUGIN_DECLARATIVE_RENDER_LANE.maxBytes)
    expect(render.maxNodes).toBe(PLUGIN_DECLARATIVE_RENDER_LANE.maxObjects)
    expect(render.maxDepth).toBe(PLUGIN_DECLARATIVE_RENDER_LANE.maxDepth)
  })

  it('sends trees the host accepts, past the shared 64 KiB and depth-100 caps', () => {
    const send = createPluginFrameSendBudget()
    const render = (tree: unknown) => ({
      orca: 1,
      kind: 'evt',
      event: 'ui.render',
      payload: { document: 'd', revision: 1, tree }
    })
    expect(send(render(chain(64)))).toBeNull()
    expect(send(render({ type: 'Text', props: {}, children: ['x'.repeat(200 * 1024)] }))).toBeNull()
    expect(send(render({ type: 'Text', props: {}, children: ['x'.repeat(700 * 1024)] }))).toEqual({
      code: 'too_large'
    })
    // Any other event keeps the shared cap.
    expect(
      send({ orca: 1, kind: 'evt', event: 'custom', payload: 'x'.repeat(200 * 1024) })
    ).toEqual({ code: 'too_large' })
  })
})
