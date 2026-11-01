import { vi } from 'vitest'

// Run the pane-close no-widening contract under main-owned layout.
vi.mock('../../shared/layout-owner-switch', () => ({ ORCA_LAYOUT_OWNER_IS_MAIN: true }))

await import('./orca-runtime-terminal-close-no-widening.test')
