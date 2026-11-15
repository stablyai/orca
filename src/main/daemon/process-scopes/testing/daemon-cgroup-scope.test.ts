import { mkdtempSync, rmSync } from 'node:fs'
import { createServer, type Server } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { migrateLegacyDaemonScope } from '../daemon-cgroup-scope'

// Use real AF_UNIX sockets so stale-file and directory fixtures cannot satisfy the bus check.
const fakeBusServers: Server[] = []
const fakeBusDirs: string[] = []
const fakeSystemdBootDirs: string[] = []

function fakeRuntimeDirWithBus(): string {
  const dir = mkdtempSync(join(tmpdir(), 'xdg-runtime-with-bus-'))
  const server = createServer()
  server.listen(join(dir, 'bus'))
  fakeBusServers.push(server)
  fakeBusDirs.push(dir)
  return dir
}

function fakeSystemdBootPath(): string {
  const dir = mkdtempSync(join(tmpdir(), 'systemd-boot-marker-'))
  fakeSystemdBootDirs.push(dir)
  return dir
}

afterEach(() => {
  for (const server of fakeBusServers.splice(0)) {
    server.close()
  }
  for (const dir of fakeBusDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true })
  }
  for (const dir of fakeSystemdBootDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true })
  }
})

describe('durable scope launch environment and lifetime (#25580, #24201)', () => {
  it('never migrates an adopted daemon into a manager that dies at logout', () => {
    const runtimeDir = fakeRuntimeDirWithBus()
    const runMigration = vi.fn(() => ({ code: 0, timedOut: false }))
    expect(
      migrateLegacyDaemonScope(321, 'new-nonce', {
        env: { XDG_RUNTIME_DIR: runtimeDir },
        platform: 'linux',
        canonicalRuntimeDir: runtimeDir,
        readProcesses: () => ({ unit: 'app-orca-1.scope', pids: [321] }),
        systemdBootPath: fakeSystemdBootPath(),
        runVersionProbe: () => ({ code: 0, timedOut: false }),
        runMigration: runMigration,
        outlivesCaller: () => false
      })
    ).toBe(false)
    expect(runMigration).not.toHaveBeenCalled()
  })
})
