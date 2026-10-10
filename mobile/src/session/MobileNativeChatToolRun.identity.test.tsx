import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, expect, it, vi } from 'vitest'
import type { NativeChatBlock } from '../../../src/shared/native-chat-types'
import { ToolRun } from './MobileNativeChatToolRun'

vi.mock('react-native', () => ({ Text: 'span', View: 'div', Pressable: 'button' }))
vi.mock('lucide-react-native', () => ({
  ChevronDown: () => null,
  SquareChevronRight: () => null,
  SquareTerminal: () => null,
  Wrench: () => null
}))
vi.mock('./mobile-native-chat-message-styles', () => ({ styles: {} }))

let tree: ReactTestRenderer | undefined
afterEach(async () => {
  await act(async () => tree?.unmount())
  tree = undefined
})

function blocks(id: string, command: string, output: string): NativeChatBlock[] {
  return [
    { type: 'tool-call', name: 'Bash', callId: id, input: { command } },
    { type: 'tool-result', callId: id, output: `preview-${id}\n${output}` }
  ]
}

async function update(next: NativeChatBlock[]): Promise<ReactTestRenderer> {
  await act(async () => {
    const element = createElement(ToolRun, {
      blocks: next,
      defaultExpanded: true,
      expandChildren: false,
      activeCall: null
    })
    if (tree) {
      tree.update(element)
    } else {
      tree = create(element)
    }
  })
  if (!tree) {
    throw new Error('Tool run did not mount.')
  }
  return tree
}

async function open(rendered: ReactTestRenderer, label: string, occurrence = 0): Promise<void> {
  const node = rendered.root.findAllByType('span').filter((item) => item.children.includes(label))[
    occurrence
  ]
  if (!node?.parent) {
    throw new Error(`Tool row is missing: ${label}`)
  }
  await act(async () => node.parent?.props.onPress())
}

function details(rendered: ReactTestRenderer): string {
  return JSON.stringify(rendered.toJSON())
}

it('keeps expansion with the same command after prefix removal, reordering and input updates', async () => {
  const first = blocks('first', 'echo first', 'FIRST_DETAIL')
  const second = blocks('second', 'echo second', 'SECOND_DETAIL')
  const third = blocks('third', 'echo third', 'THIRD_DETAIL')
  const rendered = await update([...first, ...second, ...third])
  await open(rendered, 'echo second')
  expect(details(rendered)).toContain('SECOND_DETAIL')
  expect(details(rendered)).not.toContain('FIRST_DETAIL')
  await update([...third, ...second])
  expect(details(rendered)).toContain('SECOND_DETAIL')
  expect(details(rendered)).not.toContain('THIRD_DETAIL')
  await update([...blocks('second', 'echo updated', 'UPDATED_DETAIL'), ...third])
  expect(details(rendered)).toContain('UPDATED_DETAIL')
  expect(details(rendered)).not.toContain('THIRD_DETAIL')
})

it('opens repeated provider IDs independently after an unrelated prefix disappears', async () => {
  const prefix = blocks('prefix', 'echo prefix', 'PREFIX_DETAIL')
  const duplicate = [
    ...blocks('duplicate', 'echo repeated', 'FIRST_DETAIL'),
    ...blocks('duplicate', 'echo repeated', 'SECOND_DETAIL')
  ]
  const rendered = await update([...prefix, ...duplicate])
  await open(rendered, 'echo repeated', 1)
  expect(details(rendered)).toContain('SECOND_DETAIL')
  expect(details(rendered)).not.toContain('FIRST_DETAIL')
  await update(duplicate)
  expect(details(rendered)).toContain('SECOND_DETAIL')
  expect(details(rendered)).not.toContain('FIRST_DETAIL')
})

it('does not transfer an opened orphan result to an unrelated command', async () => {
  const orphan: NativeChatBlock = {
    type: 'tool-result',
    callId: 'missing',
    output: 'ORPHAN\nDETAIL'
  }
  const rendered = await update([orphan, ...blocks('first', 'echo first', 'FIRST_DETAIL')])
  await open(rendered, 'ORPHAN')
  expect(details(rendered)).toContain('ORPHAN\\nDETAIL')
  await update(blocks('first', 'echo first', 'FIRST_DETAIL'))
  expect(details(rendered)).not.toContain('FIRST_DETAIL')
})

it('keeps a named orphan result open after a copied history refresh and output update', async () => {
  const orphan: NativeChatBlock = {
    type: 'tool-result',
    callId: 'missing',
    output: 'ORPHAN\nORIGINAL_DETAIL'
  }
  const other: NativeChatBlock = {
    type: 'tool-result',
    callId: 'other',
    output: 'OTHER\nOTHER_DETAIL'
  }
  const rendered = await update([orphan, other])
  await open(rendered, 'ORPHAN')
  expect(details(rendered)).toContain('ORIGINAL_DETAIL')
  await update([structuredClone(other), { ...orphan, output: 'ORPHAN\nUPDATED_DETAIL' }])
  expect(details(rendered)).toContain('UPDATED_DETAIL')
  expect(details(rendered)).not.toContain('OTHER_DETAIL')
})
