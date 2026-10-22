import { vi } from 'vitest'

// The same no-widening table, in a layout-owner build: a close must not widen there either.
vi.mock('../../shared/layout-owner-switch', () => ({ ORCA_LAYOUT_OWNER_IS_MAIN: true }))

await import('./orca-runtime-terminal-close-no-widening.test')
