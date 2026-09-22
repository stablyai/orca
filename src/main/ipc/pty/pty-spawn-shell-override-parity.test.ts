import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * The two spawn preflights are twins: one serves renderer/IPC spawns, the other serves runtime
 * spawns (`terminal.create` from the CLI, headless serve, and paired remote environments). They
 * had drifted — the runtime twin passed a literal `undefined` for the caller's shell, so on a
 * Windows host a runtime-created terminal could only ever be the host's default shell. A caller
 * asking for cmd or PowerShell had to send it as `command`, which the provider TYPES into that
 * default shell: the pty stayed the default shell with the requested one running inside it, and
 * leaving that child dropped the caller's handle back onto a prompt it never asked for.
 *
 * Source-level because the functional seam is a whole spawn pipeline; what actually regressed is
 * one twin silently not reading a field the other reads.
 */
const PREFLIGHTS = ['ipc', 'runtime'] as const

describe.each(PREFLIGHTS)('%s pty spawn preflight', (lane) => {
  const source = readFileSync(join(__dirname, lane, 'spawn-preflight.ts'), 'utf8')

  it("resolves Windows terminal runtime options from the caller's requested shell", () => {
    expect(source).toContain('requestedShellOverride: args.shellOverride')
    expect(source).not.toContain('requestedShellOverride: undefined')
  })
})
