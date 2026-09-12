import { describe, expect, it, vi } from 'vitest'
import type * as NodeFs from 'node:fs'

const chmodFailure = new Error('EPERM: operation not permitted')

// The module imports `chmodSync` as a direct binding, so only a module mock can
// intercept it — a namespace spy leaves the imported binding untouched.
vi.mock('node:fs', async () => {
  const actual = await vi.importActual<typeof NodeFs>('node:fs')
  return {
    ...actual,
    statSync: () => ({ mode: 0o644 }) as unknown as NodeFs.Stats,
    chmodSync: () => {
      throw chmodFailure
    }
  }
})

import { enforceCodexConfigFileMode } from './codex-config-file-mode'

describe.skipIf(process.platform === 'win32')('config file mode repair failures', () => {
  it('warns rather than failing silently when the mode cannot be restricted', () => {
    const warnings: string[] = []

    enforceCodexConfigFileMode('/tmp/orca-codex-nonexistent/config.toml', (message) =>
      warnings.push(message)
    )

    // A security repair that cannot be seen to fail is worse than one that
    // never ran: the caller is left believing the file was restricted. One
    // warning per file it tried, config and backup alike.
    expect(warnings).toHaveLength(2)
    expect(warnings[0]).toContain('644')
    expect(warnings[0]).toContain('600')
    expect(warnings[1]).toContain('.bak')
  })

  it('never throws, so a failed repair cannot break a Codex launch', () => {
    expect(() =>
      enforceCodexConfigFileMode('/tmp/orca-codex-nonexistent/config.toml')
    ).not.toThrow()
  })
})
