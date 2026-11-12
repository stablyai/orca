import { createElement } from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, expect, it, vi } from 'vitest'
import { SmartWorkspaceSourceRow } from './SmartWorkspaceSourceRow'

vi.mock('react-native', () => ({ Text: 'Text', View: 'View' }))
vi.mock('lucide-react-native', () => ({ GitBranch: 'Icon', Sparkles: 'Icon' }))
vi.mock('../theme/mobile-theme', () => ({ colors: {}, radii: {}, spacing: {} }))
vi.mock('../theme/themed-styles', () => ({ themedStyleSheet: (make) => make() }))
vi.mock('../theme/use-mobile-color-scheme', () => ({ useMobileColorScheme: () => 'dark' }))
vi.mock('../i18n/use-mobile-translation', () => ({
  useMobileTranslation: () => (_key, fallback) => fallback
}))
vi.mock('./TaskProviderLogo', () => ({ TaskProviderLogo: () => null }))
vi.mock('./list/ListGroup', () => ({ ListRow: 'ListRow' }))
let renderer: ReactTestRenderer

afterEach(() => {
  act(() => renderer?.unmount())
})

it('renders a natural remote label without a namespace subtitle and keeps collision qualification', async () => {
  const onPress = vi.fn()
  const row = {
    kind: 'branch' as const,
    value: 'branch-refs/remotes/origin/topic',
    refName: 'refs/remotes/origin/topic',
    localBranchName: 'topic'
  }
  await act(async () => {
    renderer = create(createElement(SmartWorkspaceSourceRow, { row, onPress }))
  })
  expect(renderer.toJSON()).toMatchObject({ props: { title: 'origin/topic', subtitle: 'topic' } })
  await act(async () => {
    renderer.update(
      createElement(SmartWorkspaceSourceRow, {
        row: { ...row, label: 'refs/remotes/origin/topic' },
        onPress
      })
    )
  })
  expect(renderer.toJSON()).toMatchObject({
    props: { title: 'refs/remotes/origin/topic', subtitle: 'topic' }
  })
})
