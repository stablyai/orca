import { vi } from 'vitest'

// Production requires ssh2 lazily (#35731); load it through import so each file's vi.mock('ssh2') still applies.
vi.mock('../../src/main/ssh/ssh2-module-load', async () => {
  const ssh2 = await import('ssh2')
  return { loadSsh2: () => ssh2 }
})
