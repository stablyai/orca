import { once } from 'node:events'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { build } from 'esbuild'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { runProcess, spawnProcess } from '../../shared/child-process/run-process'

describe.skipIf(process.platform === 'win32')('real sidecar exit reaping', () => {
  let directory = ''
  let entry = ''

  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), 'orca-sidecar-reaping-'))
    entry = join(directory, 'sidecar.cjs')
    await build({
      entryPoints: [join(__dirname, 'sidecar-entry.ts')],
      outfile: entry,
      bundle: true,
      platform: 'node',
      format: 'cjs',
      logLevel: 'silent',
      plugins: [
        {
          name: 'fault-injected-provider',
          setup(builder) {
            builder.onLoad({ filter: /computer-provider-lifecycle\.ts$/ }, () => ({
              resolveDir: __dirname,
              loader: 'ts',
              contents: `
              import { once } from 'node:events';
              import { writeFileSync } from 'node:fs';
              import { spawnProcess } from '../../shared/child-process/run-process';
              import { reapMacOSProviderProcess } from './macos-native-provider-process-reaping';
              let child;
              export function currentComputerProvider() {
                return { capabilities: async () => {
                  child = spawnProcess({
                    program: process.execPath,
                    args: ['-e', "process.on('SIGTERM', () => {}); process.on('SIGHUP', () => {}); setInterval(() => {}, 1000); process.stdout.write('ready');"],
                    detached: true,
                    stdio: ['ignore', 'pipe', 'ignore']
                  });
                  writeFileSync(process.env.ORCA_TEST_PROVIDER_PID_FILE, String(child.pid));
                  child.unref();
                  await once(child.stdout, 'data');
                  child.stdout.destroy();
                  child.kill('SIGSTOP');
                  return { ready: true };
                }};
              }
              export function shutdownComputerProviders() {
                if (child) reapMacOSProviderProcess(child);
              }
            `
            }))
          }
        }
      ]
    })
  })

  afterAll(async () => {
    if (directory) {
      await rm(directory, { recursive: true, force: true })
    }
  })

  async function isRunning(pid: number): Promise<boolean> {
    const result = await runProcess({
      program: '/bin/ps',
      args: ['-o', 'stat=', '-p', String(pid)],
      timeoutMs: 5_000
    })
    // Linux containers may retain exited grandchildren as zombies until PID 1 reaps them.
    return result.code === 0 && !result.stdout.trim().startsWith('Z')
  }

  it.each(['SIGTERM', 'SIGINT', 'disconnect'] as const)(
    'does not leave a stopped, SIGTERM-resistant helper after %s',
    async (mode) => {
      const pidFile = join(directory, `${mode}.pid`)
      const sidecar = spawnProcess({
        program: process.execPath,
        args: [entry],
        env: { ...process.env, ORCA_BACKGROUND_LAUNCH: '1', ORCA_TEST_PROVIDER_PID_FILE: pidFile },
        stdio: ['ignore', 'pipe', 'pipe', 'ipc']
      })
      const sidecarExit = once(sidecar, 'exit')
      try {
        const response = once(sidecar, 'message')
        sidecar.send({ id: 1, method: 'capabilities' })
        expect((await response)[0]).toMatchObject({ id: 1, ok: true, result: { ready: true } })
        const pid = Number(await readFile(pidFile, 'utf8'))
        expect(Number.isInteger(pid) && pid > 0).toBe(true)
        expect(await isRunning(pid)).toBe(true)

        if (mode === 'disconnect') {
          sidecar.disconnect()
        } else {
          sidecar.kill(mode)
        }
        await sidecarExit

        await vi.waitFor(async () => expect(await isRunning(pid)).toBe(false), {
          timeout: 5_000,
          interval: 100
        })
      } finally {
        if (sidecar.exitCode === null && sidecar.signalCode === null) {
          sidecar.kill('SIGKILL')
          await sidecarExit
        }
        const pid = Number(await readFile(pidFile, 'utf8').catch(() => '0'))
        if (Number.isInteger(pid) && pid > 0 && (await isRunning(pid))) {
          process.kill(pid, 'SIGKILL')
        }
      }
    }
  )
})
