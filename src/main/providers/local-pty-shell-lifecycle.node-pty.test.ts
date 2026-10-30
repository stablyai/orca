import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { LocalPtyProvider } from './local-pty-provider'

vi.mock('electron', () => ({ app: { getPath: () => process.env.ORCA_USER_DATA_PATH } }))

describe.skipIf(process.platform === 'win32')('direct local Bash lifecycle', () => {
  // Real PTY startup and descendant shutdown have bounded process-host waits.
  it('fences observation to the live PTY and never exposes the private binding', async () => {
    const home = mkdtempSync(join(tmpdir(), 'orca-direct-lifecycle-'))
    const original = process.env.ORCA_USER_DATA_PATH
    process.env.ORCA_USER_DATA_PATH = join(home, 'orca-data')
    writeFileSync(join(home, '.bash_profile'), "unset HISTFILE; PS1='DIRECT_PROMPT> '\n")
    let output = ''
    const provider = new LocalPtyProvider({
      getDefaultShell: () => '/bin/bash',
      onData: (_id, data) => {
        output += data
      }
    })
    let id: string | undefined
    try {
      const spawned = await provider.spawn({
        cols: 80,
        rows: 24,
        cwd: home,
        command: ':',
        commandDelivery: 'provider',
        env: { HOME: home, SHELL: '/bin/bash', TERM: 'xterm-256color' }
      })
      id = spawned.id
      const inspect = () =>
        provider.inspectProcess(spawned.id, {
          expectedIncarnationId: spawned.incarnationId,
          includeShellLifecycle: true,
          scanChildProcesses: true
        })
      await vi.waitFor(() => expect(output).toContain('DIRECT_PROMPT> '))
      await vi.waitFor(async () =>
        expect((await inspect()).shellLifecycle).toEqual(
          expect.objectContaining({ phase: 'prompt' })
        )
      )
      provider.write(spawned.id, "read -e -r -p 'DIRECT_READ> ' answer\r")
      await vi.waitFor(() => expect(output).toMatch(/DIRECT_READ> $/))
      expect((await inspect()).shellLifecycle).toMatchObject({ phase: 'running' })
      const mismatch = await provider.inspectProcess(spawned.id, {
        expectedIncarnationId: 'retired',
        includeShellLifecycle: true
      })
      expect(mismatch.shellLifecycle?.phase).not.toBe('prompt')
      const before = output.split('DIRECT_PROMPT> ').length
      provider.write(spawned.id, 'done\r')
      await vi.waitFor(() => expect(output.split('DIRECT_PROMPT> ').length).toBeGreaterThan(before))
      await vi.waitFor(async () =>
        expect((await inspect()).shellLifecycle).toMatchObject({ phase: 'prompt' })
      )
      expect(output).not.toContain('orca-shell-lifecycle;')
    } finally {
      if (id) {
        await provider.shutdown(id, { immediate: true })
      }
      if (original === undefined) {
        delete process.env.ORCA_USER_DATA_PATH
      } else {
        process.env.ORCA_USER_DATA_PATH = original
      }
      rmSync(home, { recursive: true, force: true })
    }
  }, 15_000)
})
