import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const harness = await vi.hoisted(async () => await import('./mobile-web-shell-screen-test-harness'))
const dependencies = vi.hoisted(() => harness.createScreenDependencies())

const { screenModuleMocks } = await vi.hoisted(
  async () => await import('./mobile-web-shell-screen-test-mocks')
)
const mocks = vi.hoisted(() => screenModuleMocks(dependencies))
vi.mock('react-native', mocks['react-native'])
vi.mock('expo-clipboard', mocks['expo-clipboard'])
vi.mock('expo-haptics', mocks['expo-haptics'])
vi.mock('expo-document-picker', mocks['expo-document-picker'])
vi.mock('@orca/expo-two-way-audio', mocks['@orca/expo-two-way-audio'])
vi.mock('expo-keep-awake', mocks['expo-keep-awake'])
vi.mock('expo-image-picker', mocks['expo-image-picker'])
vi.mock('expo-file-system', mocks['expo-file-system'])
vi.mock('../device-store/device-store', mocks['../device-store/device-store'])
vi.mock('lucide-react-native', mocks['lucide-react-native'])
vi.mock('react-native-safe-area-context', mocks['react-native-safe-area-context'])
vi.mock('expo-router', mocks['expo-router'])
vi.mock('../../modules/orca-mobile-web-shell/src', mocks['../../modules/orca-mobile-web-shell/src'])
vi.mock('../app-update/use-wall-app-update', mocks['../app-update/use-wall-app-update'])
vi.mock('../transport/host-client-hooks', mocks['../transport/host-client-hooks'])
vi.mock('./use-page-host-snapshot', mocks['./use-page-host-snapshot'])
vi.mock('./use-mobile-web-shell-session', mocks['./use-mobile-web-shell-session'])
import { act } from 'react-test-renderer'
import {
  byName,
  readyState,
  renderScreen as mountScreen,
  textOf
} from './mobile-web-shell-screen-test-harness'
import { MobileWebShellScreen } from './MobileWebShellScreen'
import type { MobileWebShellSessionState } from './mobile-web-shell-session-contract'
import type { ReactTestInstance, ReactTestRenderer } from 'react-test-renderer'

const renderScreen = (state: MobileWebShellSessionState): Promise<ReactTestRenderer> =>
  mountScreen(MobileWebShellScreen, dependencies, state)

afterEach(harness.unmountRenderedScreens)

beforeEach(() => {
  harness.resetScreenDependencies(dependencies)
})

// Keep update refusal separate from the working fallback document; dismissing its notice must not reload that document.
describe('a refused update is said beside the page, not in front of it', () => {
  function dismissControl(tree: ReactTestRenderer): ReactTestInstance | undefined {
    return byName(tree, 'Pressable').find(
      (node) => node.props.accessibilityLabel === 'Dismiss notice'
    )
  }

  it('keeps the same document mounted when the notice is dismissed', async () => {
    dependencies.updateNotice = 'update-failed'
    const tree = await renderScreen(readyState('session-one'))
    dependencies.lifecycle.length = 0
    await act(async () => {
      tree.root
        .find(
          (node) =>
            String(node.type) === 'Pressable' && node.props.accessibilityLabel === 'Dismiss notice'
        )
        .props.onPress()
    })
    expect(dismissControl(tree)).toBeUndefined()
    expect(textOf(tree)).not.toContain("Couldn't update")
    expect(byName(tree, 'ShellViewProbe')).toHaveLength(1)
    expect(dependencies.lifecycle).toEqual([])
  })
})
