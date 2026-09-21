import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { spawn, type ChildProcess } from 'node:child_process'
import {
  constants as fsConstants,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  renameSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import type { MacProcessCodeIdentity } from './daemon-mac-code-identity'
import { getDaemonPidPath, serializeDaemonPidFile } from './daemon-spawner'
import {
  classifyMacDaemonCodeIdentity,
  findMacAppBundleRoot,
  getMacDaemonTccAttributionHealth
} from './daemon-tcc-attribution'
import { getProcessStartedAtMs } from './daemon-process-start-time'
import { parseDaemonPidFile } from './daemon-pid-file-parse'

// Real-process harness (same shape as daemon-bundle-staleness.test.ts): the health
// check only trusts a pid record whose process is verifiably the daemon, so these
// tests spawn a daemon-shaped child instead of mocking process identity.
function spawnDaemonLikeProcess(socketPath: string, tokenPath: string) {
  return spawn(
    process.execPath,
    [
      '-e',
      'setTimeout(() => {}, 30000)',
      'daemon-entry',
      '--socket',
      socketPath,
      '--token',
      tokenPath
    ],
    { stdio: 'ignore' }
  )
}

async function getStartedAtMs(pid: number | undefined): Promise<number | null> {
  if (!pid) {
    return null
  }
  await new Promise((resolve) => setTimeout(resolve, 100))
  return getProcessStartedAtMs(pid)
}

describe('parseDaemonPidFile spawnerExecPath', () => {
  it('round-trips the spawner exec path', () => {
    const parsed = parseDaemonPidFile(
      serializeDaemonPidFile({
        pid: 123,
        startedAtMs: 1,
        spawnerExecPath: '/Applications/Orca.app/Contents/MacOS/Orca'
      })
    )
    expect(parsed?.spawnerExecPath).toBe('/Applications/Orca.app/Contents/MacOS/Orca')
  })

  it('reads legacy records without a spawner exec path as null', () => {
    expect(
      parseDaemonPidFile(serializeDaemonPidFile({ pid: 123, startedAtMs: 1 }))?.spawnerExecPath
    ).toBeNull()
    expect(parseDaemonPidFile('123')?.spawnerExecPath).toBeNull()
  })
})

describe('macOS daemon TCC attribution health', () => {
  let dir: string
  let socketPath: string
  let tokenPath: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'daemon-tcc-attribution-test-'))
    socketPath = join(dir, 'daemon.sock')
    tokenPath = join(dir, 'daemon.token')
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  async function withDaemonLikeProcess(
    run: (writePidFile: (extra: Record<string, unknown>) => void) => Promise<void>
  ): Promise<void> {
    const child = spawnDaemonLikeProcess(socketPath, tokenPath)
    try {
      const startedAtMs = await getStartedAtMs(child.pid)
      if (startedAtMs === null || !child.pid) {
        return
      }
      const writePidFile = (extra: Record<string, unknown>): void => {
        writeFileSync(
          getDaemonPidPath(dir),
          JSON.stringify({ pid: child.pid, startedAtMs, ...extra }),
          { mode: 0o600 }
        )
      }
      await run(writePidFile)
    } finally {
      child.kill('SIGKILL')
    }
  }

  it('reports severed when the recorded spawning binary no longer exists', async () => {
    if (process.platform !== 'darwin') {
      return
    }
    await withDaemonLikeProcess(async (writePidFile) => {
      writePidFile({ spawnerExecPath: join(dir, 'deleted-bundle', 'Orca') })
      expect(await getMacDaemonTccAttributionHealth(dir, socketPath, tokenPath)).toBe('severed')
    })
  })

  it('reports intact when the recorded spawning binary still exists', async () => {
    if (process.platform !== 'darwin') {
      return
    }
    await withDaemonLikeProcess(async (writePidFile) => {
      const spawnerPath = join(dir, 'Orca')
      writeFileSync(spawnerPath, '', 'utf8')
      writePidFile({ spawnerExecPath: spawnerPath, appVersion: '1.2.3' })
      expect(await getMacDaemonTccAttributionHealth(dir, socketPath, tokenPath)).toBe('intact')
    })
  })

  it('reports intact after an app-version change when the spawning binary path still exists', async () => {
    if (process.platform !== 'darwin') {
      return
    }
    await withDaemonLikeProcess(async (writePidFile) => {
      const spawnerPath = join(dir, 'Orca')
      writeFileSync(spawnerPath, '', 'utf8')
      writePidFile({ spawnerExecPath: spawnerPath, appVersion: '1.2.2' })
      expect(await getMacDaemonTccAttributionHealth(dir, socketPath, tokenPath)).toBe('intact')
    })
  })

  it('judges the daemon by its own executable when no spawning binary was recorded', async () => {
    if (process.platform !== 'darwin') {
      return
    }
    await withDaemonLikeProcess(async (writePidFile) => {
      writePidFile({})
      expect(await getMacDaemonTccAttributionHealth(dir, socketPath, tokenPath)).toBe('intact')
      writePidFile({ appVersion: '1.2.2' })
      expect(await getMacDaemonTccAttributionHealth(dir, socketPath, tokenPath)).toBe('intact')
    })
  })

  it('fails open without a recorded spawning binary when code identity is unavailable', async () => {
    if (process.platform !== 'darwin') {
      return
    }
    await withDaemonLikeProcess(async (writePidFile) => {
      writePidFile({})
      expect(
        await getMacDaemonTccAttributionHealth(dir, socketPath, tokenPath, undefined, {
          inspectCodeIdentity: async () => ({ status: 'unavailable' })
        })
      ).toBe('unknown')
    })
  })

  it('fails open when no verifiable pid record exists', async () => {
    if (process.platform !== 'darwin') {
      return
    }
    expect(await getMacDaemonTccAttributionHealth(dir, socketPath, tokenPath)).toBe('unknown')
  })

  it('reports unknown off macOS', async () => {
    if (process.platform === 'darwin') {
      return
    }
    expect(await getMacDaemonTccAttributionHealth(dir, socketPath, tokenPath)).toBe('unknown')
  })
})

describe('findMacAppBundleRoot', () => {
  it('finds the nearest .app ancestor of a bundled executable', () => {
    expect(findMacAppBundleRoot('/Applications/Orca.app/Contents/MacOS/Orca')).toBe(
      '/Applications/Orca.app'
    )
    expect(
      findMacAppBundleRoot(
        '/Applications/Orca.app/Contents/Frameworks/Orca Helper.app/Contents/MacOS/Orca Helper'
      )
    ).toBe('/Applications/Orca.app/Contents/Frameworks/Orca Helper.app')
  })

  it('returns null for an unbundled executable', () => {
    expect(findMacAppBundleRoot('/opt/homebrew/bin/node')).toBeNull()
    expect(findMacAppBundleRoot('/')).toBeNull()
  })
})

// #20007: the daemon outlives the bundle it was exec'd from. An in-place update deletes and
// recreates spawnerExecPath, so that path always exists — the daemon's OWN executable is what
// Squirrel parks and later deletes, and what tccd fails to resolve.
describe('macOS daemon TCC attribution health from the daemon executable (#20007)', () => {
  let dir: string
  let socketPath: string
  let tokenPath: string
  let spawnerExecPath: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'daemon-tcc-own-executable-test-'))
    socketPath = join(dir, 'daemon.sock')
    tokenPath = join(dir, 'daemon.token')
    spawnerExecPath = join(dir, 'Applications', 'Orca.app', 'Contents', 'MacOS', 'Orca')
    mkdirSync(dirname(spawnerExecPath), { recursive: true })
    writeFileSync(spawnerExecPath, '')
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  function helperPathInside(bundleRoot: string): string {
    return join(
      bundleRoot,
      'Contents',
      'Frameworks',
      'Orca Helper.app',
      'Contents',
      'MacOS',
      'Orca Helper'
    )
  }

  async function withDaemonLikeProcess(
    run: (
      writePidFile: (extra: Record<string, unknown>) => void,
      child: ChildProcess
    ) => Promise<void>
  ): Promise<void> {
    const child = spawnDaemonLikeProcess(socketPath, tokenPath)
    try {
      const startedAtMs = await getStartedAtMs(child.pid)
      if (startedAtMs === null || !child.pid) {
        return
      }
      const writePidFile = (extra: Record<string, unknown>): void => {
        writeFileSync(
          getDaemonPidPath(dir),
          JSON.stringify({ pid: child.pid, startedAtMs, spawnerExecPath, ...extra }),
          { mode: 0o600 }
        )
      }
      await run(writePidFile, child)
    } finally {
      child.kill('SIGKILL')
    }
  }

  function inspecting(identity: MacProcessCodeIdentity) {
    return { inspectCodeIdentity: vi.fn(async () => identity) }
  }

  it('reports severed when the spawning binary exists but the daemon executable was unlinked', async () => {
    if (process.platform !== 'darwin') {
      return
    }
    await withDaemonLikeProcess(async (writePidFile) => {
      writePidFile({ appVersion: '1.4.197' })
      const dependencies = inspecting({ status: 'unresolvable' })
      expect(
        await getMacDaemonTccAttributionHealth(dir, socketPath, tokenPath, undefined, dependencies)
      ).toBe('severed')
      expect(dependencies.inspectCodeIdentity).toHaveBeenCalledTimes(1)
    })
  })

  it('reports severed when the daemon executable resolves to a path that no longer exists', async () => {
    if (process.platform !== 'darwin') {
      return
    }
    await withDaemonLikeProcess(async (writePidFile) => {
      writePidFile({})
      expect(
        await getMacDaemonTccAttributionHealth(
          dir,
          socketPath,
          tokenPath,
          undefined,
          inspecting({
            status: 'resolved',
            executablePath: helperPathInside(join(dir, 'Applications', 'Orca.app'))
          })
        )
      ).toBe('severed')
    })
  })

  it('reports severed when the daemon runs from a bundle parked outside the installed app', async () => {
    if (process.platform !== 'darwin') {
      return
    }
    const parkedHelper = helperPathInside(
      join(dir, 'T', 'com.stablyai.orca.ShipIt.abc', 'Orca.app')
    )
    mkdirSync(dirname(parkedHelper), { recursive: true })
    writeFileSync(parkedHelper, '')
    await withDaemonLikeProcess(async (writePidFile) => {
      writePidFile({})
      expect(
        await getMacDaemonTccAttributionHealth(
          dir,
          socketPath,
          tokenPath,
          undefined,
          inspecting({ status: 'resolved', executablePath: parkedHelper })
        )
      ).toBe('severed')
    })
  })

  it('reports intact while the daemon executable still lives inside the installed bundle', async () => {
    if (process.platform !== 'darwin') {
      return
    }
    const helper = helperPathInside(join(dir, 'Applications', 'Orca.app'))
    mkdirSync(dirname(helper), { recursive: true })
    writeFileSync(helper, '')
    await withDaemonLikeProcess(async (writePidFile) => {
      writePidFile({})
      expect(
        await getMacDaemonTccAttributionHealth(
          dir,
          socketPath,
          tokenPath,
          undefined,
          inspecting({ status: 'resolved', executablePath: helper })
        )
      ).toBe('intact')
    })
  })

  it('re-inspects a cached intact verdict once the daemon executable disappears', async () => {
    if (process.platform !== 'darwin') {
      return
    }
    const helper = helperPathInside(join(dir, 'Applications', 'Orca.app'))
    mkdirSync(dirname(helper), { recursive: true })
    writeFileSync(helper, '')
    await withDaemonLikeProcess(async (writePidFile) => {
      writePidFile({})
      const dependencies = inspecting({ status: 'resolved', executablePath: helper })
      expect(
        await getMacDaemonTccAttributionHealth(dir, socketPath, tokenPath, undefined, dependencies)
      ).toBe('intact')
      expect(
        await getMacDaemonTccAttributionHealth(dir, socketPath, tokenPath, undefined, dependencies)
      ).toBe('intact')
      expect(dependencies.inspectCodeIdentity).toHaveBeenCalledTimes(1)

      // The next update deletes the parked copy: the pid record is unchanged, the verdict is not.
      rmSync(helper)
      dependencies.inspectCodeIdentity.mockResolvedValue({ status: 'unresolvable' })
      expect(
        await getMacDaemonTccAttributionHealth(dir, socketPath, tokenPath, undefined, dependencies)
      ).toBe('severed')
      expect(dependencies.inspectCodeIdentity).toHaveBeenCalledTimes(2)
    })
  })

  it('falls back to the spawning binary when code identity is unavailable', async () => {
    if (process.platform !== 'darwin') {
      return
    }
    await withDaemonLikeProcess(async (writePidFile) => {
      writePidFile({})
      expect(
        await getMacDaemonTccAttributionHealth(
          dir,
          socketPath,
          tokenPath,
          undefined,
          inspecting({ status: 'unavailable' })
        )
      ).toBe('intact')
    })
  })

  // End to end against the real codesign(1): a daemon-shaped copy of this node binary runs from
  // a fake bundle; the bundle is parked, then deleted, exactly as Squirrel does across two updates.
  it('detects the parked and then deleted bundle through codesign on the live pid', async () => {
    if (process.platform !== 'darwin') {
      return
    }
    const installedBundle = join(dir, 'Applications', 'Orca.app')
    const helper = helperPathInside(installedBundle)
    mkdirSync(dirname(helper), { recursive: true })
    copyFileSync(process.execPath, helper, fsConstants.COPYFILE_FICLONE)
    const child = spawn(
      helper,
      [
        '-e',
        'setTimeout(() => {}, 30000)',
        'daemon-entry',
        '--socket',
        socketPath,
        '--token',
        tokenPath
      ],
      {
        stdio: 'ignore',
        // Why: a dynamically linked node (Homebrew) finds libnode via @loader_path/../lib.
        env: { ...process.env, DYLD_LIBRARY_PATH: join(dirname(dirname(process.execPath)), 'lib') }
      }
    )
    try {
      const startedAtMs = await getStartedAtMs(child.pid)
      if (startedAtMs === null || !child.pid || child.exitCode !== null) {
        // This node build cannot run from a copied location; the injected-identity tests above cover the verdicts.
        return
      }
      writeFileSync(
        getDaemonPidPath(dir),
        JSON.stringify({ pid: child.pid, startedAtMs, spawnerExecPath }),
        { mode: 0o600 }
      )
      expect(await getMacDaemonTccAttributionHealth(dir, socketPath, tokenPath)).toBe('intact')

      // Update 1: Squirrel parks the running bundle and installs a fresh one at the old path.
      const parkedBundle = join(dir, 'T', 'com.stablyai.orca.ShipIt.abc', 'Orca.app')
      mkdirSync(dirname(parkedBundle), { recursive: true })
      renameSync(installedBundle, parkedBundle)
      mkdirSync(dirname(spawnerExecPath), { recursive: true })
      writeFileSync(spawnerExecPath, '')
      expect(await getMacDaemonTccAttributionHealth(dir, socketPath, tokenPath)).toBe('severed')

      // Update 2: the parked copy is deleted; the daemon's executable is now unlinked.
      rmSync(parkedBundle, { recursive: true, force: true })
      expect(await getMacDaemonTccAttributionHealth(dir, socketPath, tokenPath)).toBe('severed')
    } finally {
      child.kill('SIGKILL')
    }
  })
})

describe('classifyMacDaemonCodeIdentity', () => {
  it('maps an unresolvable identity to severed regardless of the spawning binary', () => {
    expect(classifyMacDaemonCodeIdentity({ status: 'unresolvable' }, process.execPath)).toBe(
      'severed'
    )
    expect(classifyMacDaemonCodeIdentity({ status: 'unresolvable' }, null)).toBe('severed')
  })

  it('keeps the spawning-binary verdict when the identity probe is unavailable', () => {
    expect(classifyMacDaemonCodeIdentity({ status: 'unavailable' }, process.execPath)).toBe(
      'intact'
    )
    expect(
      classifyMacDaemonCodeIdentity({ status: 'unavailable' }, '/nonexistent/Orca.app/MacOS/Orca')
    ).toBe('unknown')
    expect(classifyMacDaemonCodeIdentity({ status: 'unavailable' }, null)).toBe('unknown')
  })

  it('skips the bundle check when the spawning binary is not bundled', () => {
    expect(
      classifyMacDaemonCodeIdentity(
        { status: 'resolved', executablePath: process.execPath },
        process.execPath
      )
    ).toBe('intact')
  })
})
