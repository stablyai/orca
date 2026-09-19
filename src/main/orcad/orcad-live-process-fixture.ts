import { mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { spawnProcess, type SpawnedProcess } from '../../shared/child-process/run-process'
import { forceTerminateProcessTree } from '../../shared/child-process/process-tree-termination'
import { orcadBunRuntimeFilename } from '../../shared/orcad-artifacts'
import { PTY_OWNERSHIP_TRANSFER_CANARY_ENV } from '../../shared/pty-ownership-transfer-release-gate'
import { decodePairingOffer } from '../../shared/pairing'
import { sendRemoteRuntimeRequest } from '../../shared/remote-runtime-client'
import { ELECTRON_REMOTE_RUNTIME_CLIENT_CAPABILITIES } from '../../shared/protocol-version'

export function createLiveOrcadProcess(
  entry: string,
  directory: string,
  options: { mutationEnabled?: boolean } = {}
) {
  const privateHome = join(directory, 'home')
  mkdirSync(privateHome, { recursive: true })
  let child: SpawnedProcess | undefined
  let port = 0
  let pairing: ReturnType<typeof decodePairingOffer>
  let diagnostics = ''
  let startupDurationMs = 0
  const stop = async (signal: 'SIGTERM' | 'SIGKILL' = 'SIGTERM') => {
    if (!child) {
      return
    }
    const current = child
    const failures: unknown[] = []
    if (current.exitCode === null && current.signalCode === null) {
      try {
        await new Promise<void>((resolve, reject) => {
          const finish = (error?: unknown) => {
            clearTimeout(timer)
            current.removeListener('exit', onExit)
            if (error) {
              reject(error)
            } else {
              resolve()
            }
          }
          const onExit = () => finish()
          const timer = setTimeout(
            () => finish(new Error(`orcad did not exit: ${diagnostics}`)),
            20_000
          )
          current.once('exit', onExit)
          try {
            current.kill(signal)
          } catch (error) {
            finish(error)
          }
        })
      } catch (error) {
        failures.push(error)
      }
    }
    if (process.platform !== 'win32') {
      // The test owns this detached group; crash-surviving browser sidecars are not user work.
      try {
        if (!(await forceTerminateProcessTree(current))) {
          throw new Error('fixture_orcad_process_group_cleanup_unverifiable')
        }
      } catch (error) {
        failures.push(error)
      }
    }
    if (failures.length === 1) {
      throw failures[0]
    }
    if (failures.length > 1) {
      throw new AggregateError(failures, 'fixture_orcad_stop_failed')
    }
  }
  const start = async () => {
    if (child && child.exitCode === null && child.signalCode === null) {
      throw new Error('fixture_orcad_already_running')
    }
    diagnostics = ''
    startupDurationMs = 0
    const startedAt = performance.now()
    const elapsed = () => Math.round(performance.now() - startedAt)
    child = spawnProcess({
      program: join(dirname(entry), orcadBunRuntimeFilename(process.platform)),
      args: [entry, '--port', String(port), '--json'],
      cwd: directory,
      detached: process.platform !== 'win32',
      env: {
        ...process.env,
        ORCA_BACKGROUND_LAUNCH: '1',
        ORCA_TEST_MOCK_KEYCHAIN: '1',
        VITEST: undefined,
        ORCA_DAEMON_ENTRY_LOAD_CHECK: undefined,
        HOME: privateHome,
        USERPROFILE: privateHome,
        ORCA_USER_DATA: join(directory, 'data'),
        [PTY_OWNERSHIP_TRANSFER_CANARY_ENV]: options.mutationEnabled === false ? '0' : '1'
      }
    })
    const current = child
    const serving = await new Promise<{ pairing: { url: string }; runtimeId: string }>(
      (resolve, reject) => {
        let output = ''
        const timer = setTimeout(
          () => reject(new Error(`orcad readiness timed out: ${diagnostics}`)),
          150_000
        )
        current.stderr?.on('data', (bytes) => {
          diagnostics = `${diagnostics}[${elapsed()}ms] ${String(bytes)}`.slice(-32_768)
        })
        current.stdout?.on('data', (bytes) => {
          output += String(bytes)
          let newline: number
          while ((newline = output.indexOf('\n')) !== -1) {
            const line = output.slice(0, newline)
            output = output.slice(newline + 1)
            try {
              const message = JSON.parse(line)
              if (message.type === 'orca_server_ready') {
                clearTimeout(timer)
                startupDurationMs = elapsed()
                resolve(message)
              }
            } catch {
              /* Startup diagnostics share stdout with readiness. */
            }
          }
        })
        current.once('error', (error) => {
          clearTimeout(timer)
          reject(error)
        })
        current.once('exit', (code) => {
          clearTimeout(timer)
          reject(new Error(`orcad exited ${code}: ${diagnostics}`))
        })
      }
    )
    pairing = decodePairingOffer(serving.pairing.url)
    port = Number(new URL(pairing.endpoint).port)
    return serving
  }
  return {
    start,
    stop,
    diagnostics: () => diagnostics,
    startupDurationMs: () => startupDurationMs,
    rpc: async (method: string, params: unknown) => {
      const result = await sendRemoteRuntimeRequest(
        pairing,
        method,
        params,
        30_000,
        undefined,
        undefined,
        ELECTRON_REMOTE_RUNTIME_CLIENT_CAPABILITIES
      )
      if (!result.ok) {
        throw new Error(`${method}: ${result.error.message}`)
      }
      return result.result
    }
  }
}
