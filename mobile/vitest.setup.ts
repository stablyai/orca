import { vi } from 'vitest'

// Native SVG's generated components import Flow-only native subpaths outside the RN host mocks.
vi.mock('react-native-svg', () => ({
  default: 'Svg',
  Defs: 'Defs',
  G: 'G',
  LinearGradient: 'LinearGradient',
  Path: 'Path',
  Rect: 'Rect',
  Stop: 'Stop'
}))

// expo-speech's module reads the RN `__DEV__` global at import, which only the RN runtime defines.
vi.mock('expo-speech', () => ({ speak: () => {}, stop: () => Promise.resolve() }))

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
