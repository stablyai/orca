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

// The reserved-regions module is iOS-only native code; tests run as a platform without it.
vi.mock('./modules/orca-reserved-regions/src', () => ({ OrcaReservedRegions: null }))

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
