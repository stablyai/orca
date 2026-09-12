import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { expect, vi } from 'vitest'
import { runProcess, spawnProcess } from '../shared/child-process/run-process'
import { forceTerminateProcessTree } from '../shared/child-process/process-tree-termination'
import { RELAY_VERSION } from './protocol'

export async function startLiveRelayDaemon(entry: string, bun: string, flags: string[]) {
  const runtimeVersion = await runProcess({ program: bun, args: ['--version'] })
  const [major, minor] = runtimeVersion.stdout.trim().split('.').map(Number)
  expect(major > 1 || (major === 1 && minor >= 4)).toBe(true)
  const directory = mkdtempSync(join(tmpdir(), 'orca-live-capture-'))
  const endpoint = join(directory, 'relay.sock')
  const credentialFile = join(directory, 'credential')
  const versionFile = join(dirname(realpathSync(entry)), '.version')
  const incumbentVersion = existsSync(versionFile)
    ? readFileSync(versionFile, 'utf8').trim() || RELAY_VERSION
    : RELAY_VERSION
  const child = spawnProcess({
    program: bun,
    args: [
      entry,
      '--detached',
      '--grace-time',
      '0',
      '--sock-path',
      endpoint,
      '--endpoint-dir',
      join(directory, 'hooks'),
      '--credential-file',
      credentialFile,
      ...flags
    ],
    cwd: directory,
    detached: process.platform !== 'win32',
    env: {
      ...process.env,
      HOME: directory,
      USERPROFILE: directory,
      ORCA_BACKGROUND_LAUNCH: '1'
    }
  })
  let diagnostic = ''
  let launchError: Error | undefined
  child.once('error', (error) => {
    launchError = error
  })
  child.stderr?.on('data', (data) => {
    diagnostic = `${diagnostic}${String(data)}`.slice(-32_768)
  })
  child.stdout?.on('data', (data) => {
    diagnostic = `${diagnostic}${String(data)}`.slice(-32_768)
  })
  const exited = () => child.exitCode !== null || child.signalCode !== null
  const waitForExit = (timeoutMs: number) => {
    if (exited() || !child.pid) {
      return Promise.resolve(true)
    }
    return new Promise<boolean>((resolve) => {
      const finish = (confirmed: boolean) => {
        clearTimeout(timer)
        child.removeListener('exit', onExit)
        resolve(confirmed)
      }
      const onExit = () => finish(true)
      const timer = setTimeout(() => finish(exited()), timeoutMs)
      child.once('exit', onExit)
      if (exited()) {
        finish(true)
      }
    })
  }
  let disposal: Promise<void> | undefined
  const cleanup = async () => {
    if (child.pid && !exited()) {
      child.kill('SIGTERM')
      await waitForExit(2_000)
    }
    // Transfers may refuse graceful shutdown; this detached fixture group contains no user work.
    if (child.pid && (process.platform !== 'win32' || !exited())) {
      const treeConfirmed = await forceTerminateProcessTree(child)
      const rootConfirmed = await waitForExit(5_000)
      if (!treeConfirmed || !rootConfirmed) {
        throw new Error(`fixture_relay_cleanup_unverifiable: retained ${directory}\n${diagnostic}`)
      }
    }
    rmSync(directory, { recursive: true, force: true })
  }
  const dispose = () => (disposal ??= cleanup())
  try {
    await vi.waitFor(
      () => {
        if (launchError) {
          throw launchError
        }
        expect(child.exitCode, diagnostic).toBeNull()
        expect(existsSync(credentialFile), diagnostic).toBe(true)
      },
      { timeout: 15_000 }
    )
    return {
      directory,
      endpoint,
      incumbentVersion,
      endpointCredential: readFileSync(credentialFile, 'utf8').trim(),
      diagnostics: () => diagnostic,
      dispose
    }
  } catch (error) {
    try {
      await dispose()
    } catch (cleanupError) {
      throw new AggregateError([error, cleanupError], 'fixture_relay_startup_and_cleanup_failed')
    }
    throw error
  }
}
