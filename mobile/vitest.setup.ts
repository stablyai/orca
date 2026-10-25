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

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
