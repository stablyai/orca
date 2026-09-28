import { cp, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join, resolve } from 'node:path'
import { expect, it } from 'vitest'
import { spawnRelay, type RelayProcess } from './subprocess-test-utils'
import { relayTestSocketPath } from './relay-test-socket-path'
import { seedHermesSessionRun } from './hermes-session-run-fixture'

const executable = process.env.BUN_EXECUTABLE

it.skipIf(!executable)(
  'bundled Bun relay preserves a real terminal across bridge reconnect',
  async ({ onTestFailed }) => {
    const directory = await mkdtemp(join(tmpdir(), 'bun-relay-'))
    const home = join(directory, 'home')
    await mkdir(home)
    const built = resolve('out', 'relay', `${process.platform}-${process.arch}`)
    let entry = join(built, 'relay.js')
    if (process.platform === 'win32') {
      const bundle = join(directory, 'bundle')
      // Exercise the shipped addon without resolving the development tree's watcher package.
      await cp(built, bundle, {
        recursive: true,
        filter: (path) => basename(path) !== 'node_modules'
      })
      entry = join(bundle, 'relay.js')
    }
    const socket = relayTestSocketPath(directory)
    const processes: RelayProcess[] = []
    const stderr = new Map<RelayProcess, string>()
    onTestFailed(() => {
      console.error(
        'Bundled relay diagnostics:',
        processes.map((child) => ({
          pid: child.proc.pid,
          exitCode: child.proc.exitCode,
          signal: child.proc.signalCode,
          stderr: stderr.get(child),
          watcherNotifications: child.responses
            .filter((message) => 'method' in message && message.method.startsWith('fs.'))
            .slice(-8)
        }))
      )
    })
    const launch = (args: string[]): RelayProcess => {
      const child = spawnRelay(
        entry,
        [...args, '--sock-path', socket, '--credential-file', join(directory, 'credential')],
        {
          executable,
          cwd: directory,
          env: {
            ...process.env,
            HOME: home,
            USERPROFILE: home,
            CODEX_HOME: join(home, '.codex'),
            HERMES_HOME: join(home, '.hermes'),
            ORCA_BACKGROUND_LAUNCH: '1'
          }
        }
      )
      child.proc.stderr?.on('data', (chunk: Buffer) => {
        stderr.set(child, `${stderr.get(child) ?? ''}${chunk.toString()}`.slice(-8_192))
      })
      processes.push(child)
      return child
    }
    let bridge: RelayProcess | undefined
    let id: string | undefined
    try {
      seedHermesSessionRun(join(home, '.hermes'))
      const daemon = launch([
        '--detached',
        '--grace-time',
        '0',
        '--endpoint-dir',
        join(directory, 'hooks')
      ])
      await daemon.sentinelReceived
      bridge = launch(['--connect'])
      await bridge.sentinelReceived
      const hello = {
        protocolVersion: 1,
        clientInstanceId: 'bun-artifact-test',
        requestedRole: 'session-owner'
      }
      const admission = await bridge.waitForResponse(bridge.send('pty.openClient', hello))
      expect(admission.error).toBeUndefined()
      const grant = admission.result
      if (
        !grant ||
        typeof grant !== 'object' ||
        !('ownerGeneration' in grant) ||
        !('ownerLease' in grant)
      ) {
        throw new Error('Relay did not grant terminal ownership')
      }
      const sessionId = '019f0000-1111-7222-8333-444444444444'
      const transcriptPath = join(home, 'rollout.jsonl')
      await writeFile(
        transcriptPath,
        `${[
          {
            timestamp: '2026-07-01T10:00:00.000Z',
            type: 'session_meta',
            payload: { id: sessionId, cwd: directory }
          },
          {
            timestamp: '2026-07-01T10:00:01.000Z',
            type: 'response_item',
            payload: {
              type: 'message',
              role: 'user',
              content: [{ type: 'text', text: 'Read a transcript under bundled Bun' }]
            }
          }
        ]
          .map((record) => JSON.stringify(record))
          .join('\n')}\n`
      )
      const titles = await bridge.waitForResponse(
        bridge.send('aiVault.resolveSessionTitles', {
          requests: [{ agent: 'codex', sessionId, transcriptPath }]
        })
      )
      expect(titles.error).toBeUndefined()
      expect(titles.result).toEqual({
        titles: [{ agent: 'codex', sessionId, title: 'Read a transcript under bundled Bun' }]
      })
      const runs = await bridge.waitForResponse(
        bridge.send('externalAutomations.runs', { provider: 'hermes', jobId: 'job-1' })
      )
      expect(runs.error).toBeUndefined()
      expect(runs.result).toMatchObject({
        total: 1,
        runs: [
          {
            id: 'cron_job-1_20260701_100000',
            status: 'completed',
            output_content: expect.stringContaining('Database-backed run output')
          }
        ]
      })
      const hooks = await bridge.waitForResponse(
        bridge.send('agent_hook.installManagedHooks', { agents: [] })
      )
      expect(hooks.error).toBeUndefined()
      expect(hooks.result).toEqual({ installers: 0, errors: 0 })
      const watchRoot = join(directory, 'watched')
      await mkdir(watchRoot)
      const watch = await bridge.waitForResponse(
        bridge.send('fs.watch', { rootPath: watchRoot, watchId: 1 }),
        10_000
      )
      expect(watch.error).toBeUndefined()
      const changed = bridge.waitForNotification('fs.changed', 10_000)
      void changed.catch(() => {})
      const createdPath = join(watchRoot, 'from-bun-companion.txt')
      await writeFile(createdPath, 'observed')
      try {
        expect((await changed).params).toMatchObject({
          events: expect.arrayContaining([
            expect.objectContaining({ kind: 'create', absolutePath: createdPath })
          ])
        })
      } catch (error) {
        // Preserve the first-event failure; distinguish missed registration from stalled delivery.
        const followup = bridge.waitForNotification('fs.changed', 2_000)
        void followup.catch(() => {})
        const followupPath = join(watchRoot, 'after-watch-timeout.txt')
        await writeFile(followupPath, 'diagnostic').catch(() => {})
        console.error('Watcher follow-up after first-event failure:', {
          watchRoot,
          createdPath,
          followupPath,
          notification: await followup.catch(() => null)
        })
        throw error
      }
      const unwatched = await bridge.waitForResponse(
        bridge.send('fs.unwatchAndWait', { rootPath: watchRoot })
      )
      expect(unwatched.error).toBeUndefined()
      const spawned = await bridge.waitForResponse(
        bridge.send('pty.spawn', {
          cwd: directory,
          cols: 80,
          rows: 24,
          shellOverride: process.platform === 'win32' ? 'cmd.exe' : '/bin/sh'
        })
      )
      expect(spawned.error).toBeUndefined()
      if (
        !spawned.result ||
        typeof spawned.result !== 'object' ||
        !('id' in spawned.result) ||
        typeof spawned.result.id !== 'string'
      ) {
        throw new Error('Relay did not return a terminal id')
      }
      id = spawned.result.id
      bridge.kill()
      await bridge.waitForExit()
      bridge = launch(['--connect'])
      await bridge.sentinelReceived
      const resumed = await bridge.waitForResponse(
        bridge.send('pty.openClient', {
          ...hello,
          resume: { ownerGeneration: grant.ownerGeneration, ownerLease: grant.ownerLease }
        })
      )
      expect(resumed.error).toBeUndefined()
      expect(resumed.result).toMatchObject({ resumed: true })
      const inventory = await bridge.waitForResponse(bridge.send('pty.listProcesses', {}))
      expect(inventory.error).toBeUndefined()
      expect(inventory.result).toEqual(expect.arrayContaining([expect.objectContaining({ id })]))
      const attached = await bridge.waitForResponse(bridge.send('pty.attach', { id }))
      expect(attached.error).toBeUndefined()
      const data =
        process.platform === 'win32'
          ? 'echo ORCA_BUN_^RECONNECTED\r'
          : "printf '%s%s\\n' ORCA_BUN_ RECONNECTED\r"
      bridge.sendNotification('pty.data', { id, data })
      await expect
        .poll(() => JSON.stringify(bridge?.responses), { timeout: 10_000 })
        .toContain('ORCA_BUN_RECONNECTED')
      if (process.platform !== 'win32') {
        bridge.sendNotification('pty.data', { id, data: 'sleep 30\r' })
        const connected = bridge
        await expect
          .poll(
            async () => {
              const observed = await connected.waitForResponse(
                connected.send('pty.getForegroundProcess', { id })
              )
              expect(observed.error).toBeUndefined()
              return observed.result
            },
            { timeout: 5000 }
          )
          .toBe('sleep')
        bridge.sendNotification('pty.data', { id, data: '\x03' })
      }
    } finally {
      if (bridge && id && bridge.proc.exitCode === null) {
        await bridge.waitForResponse(bridge.send('pty.shutdown', { id })).catch(() => {})
      }
      for (const child of processes.toReversed()) {
        if (child.proc.exitCode === null && child.proc.signalCode === null) {
          child.kill()
          await child.waitForExit(5000).catch(async () => {
            child.kill('SIGKILL')
            await child.waitForExit().catch(() => {})
          })
        }
      }
      await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
    }
  },
  30_000
)
