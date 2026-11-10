import { createElement } from 'react'
import { act, create, type ReactTestInstance, type ReactTestRenderer } from 'react-test-renderer'
import { describe, expect, it, vi } from 'vitest'

vi.mock('react-native', () => ({
  Pressable: 'Pressable',
  StyleSheet: { create: (styles: unknown) => styles },
  Text: 'Text',
  View: 'View'
}))
vi.mock('../components/MobileAgentIcon', () => ({
  MobileAgentIcon: 'MobileAgentIcon'
}))
vi.mock('../i18n/use-mobile-translation', () => ({
  useMobileTranslation: () => (_key: string, fallback: string) => fallback
}))
vi.mock('../theme/use-mobile-color-scheme', () => ({
  useMobileColorScheme: () => 'dark'
}))

import {
  ORCA_CLOUD_DEFAULT_AGENT,
  ORCA_CLOUD_IMAGE_AGENTS,
  type OrcaCloudImageAgent
} from '../../../src/shared/hosted-sandbox/orca-cloud-image-agents'
import { CloudAgentPicker } from './CloudAgentPicker'

function render(props: {
  value: OrcaCloudImageAgent
  onChange: (agent: OrcaCloudImageAgent) => void
  disabled?: boolean
}): ReactTestRenderer {
  const rendered: { tree: ReactTestRenderer | null } = { tree: null }
  act(() => {
    rendered.tree = create(createElement(CloudAgentPicker, props))
  })
  if (rendered.tree === null) {
    throw new Error('the picker did not render')
  }
  return rendered.tree
}

function radios(tree: ReactTestRenderer): ReactTestInstance[] {
  return tree.root.findAll(
    (node: ReactTestInstance) =>
      String(node.type) === 'Pressable' && node.props.accessibilityRole === 'radio'
  )
}

function iconOf(node: ReactTestInstance): string {
  return node.find((child: ReactTestInstance) => String(child.type) === 'MobileAgentIcon').props
    .agentId
}

describe('CloudAgentPicker', () => {
  it('offers exactly the agents the Orca Cloud image ships, in image order', () => {
    const tree = render({
      value: ORCA_CLOUD_DEFAULT_AGENT,
      onChange: () => {}
    })
    expect(radios(tree).map(iconOf)).toEqual([...ORCA_CLOUD_IMAGE_AGENTS])
  })

  it('is one radio group with the current agent checked', () => {
    const tree = render({ value: 'gemini', onChange: () => {} })
    const group = tree.root.find(
      (node: ReactTestInstance) => node.props.accessibilityRole === 'radiogroup'
    )
    expect(group.props.accessibilityLabel).toBe('Agent')
    const checked = radios(tree).filter((node) => node.props.accessibilityState.checked)
    expect(checked.map(iconOf)).toEqual(['gemini'])
  })

  it('reports the pressed agent and holds every chip while disabled', () => {
    const picks: string[] = []
    const tree = render({
      value: 'claude',
      onChange: (agent) => picks.push(agent)
    })
    const cursor = radios(tree).find((node) => iconOf(node) === 'cursor')!
    act(() => cursor.props.onPress())
    expect(picks).toEqual(['cursor'])

    const disabled = render({
      value: 'claude',
      onChange: () => {},
      disabled: true
    })
    expect(radios(disabled).every((node) => node.props.disabled === true)).toBe(true)
  })
})
