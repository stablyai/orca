import { vi } from 'vitest'

// The same cold-restore table in a layout-owner build, where main's own panes are in the graph:
// a registration still reaches clients in one push, with no second one from a later frame.
vi.mock('../../shared/layout-owner-switch', () => ({ ORCA_LAYOUT_OWNER_IS_MAIN: true }))

await import('./orca-runtime-cold-restore-terminal-membership.test')
