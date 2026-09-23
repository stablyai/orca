import { vi } from 'vitest'

export const applyElectronProxySettings = vi.fn(async () => ({ source: 'direct' as const }))
