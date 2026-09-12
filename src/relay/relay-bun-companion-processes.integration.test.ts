import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { build } from 'esbuild'
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { spawnSync } from 'node:child_process'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { spawnRelay, type RelayProcess } from './subprocess-test-utils'
import { relayTestSocketPath } from './relay-test-socket-path'

const projectRoot = resolve(__dirname, '..', '..')
const builtBunRuntime = join(projectRoot, 'out', 'orcad', 'bun-runtime')
const bunExecutable =
  process.env.BUN_EXECUTABLE ?? (existsSync(builtBunRuntime) ? builtBunRuntime : 'bun')
const bunAvailable =
  process.platform !== 'win32' && spawnSync(bunExecutable, ['--version']).status === 0

let bundleDir = ''
let relayEntry = ''

beforeAll(async () => {
  const bundleRoot = join(projectRoot, 'out')
  mkdirSync(bundleRoot, { recursive: true })
  // Keep the bundle under the repository so its external native watcher resolves
  // through the same ancestor node_modules relationship as a deployed slot.
  bundleDir = mkdtempSync(join(bundleRoot, '.relay-bun-companions-'))
  relayEntry = join(bundleDir, 'relay.js')
  const common = {
    bundle: true,
    platform: 'node' as const,
    target: 'node18',
    format: 'cjs' as const,
    sourcemap: false
  }
  await Promise.all([
    build({
      ...common,
      entryPoints: [join(projectRoot, 'src/relay/relay.ts')],
      outfile: relayEntry,
      external: ['node-pty', '@parcel/watcher', 'electron']
    }),
    build({
      ...common,
      entryPoints: [join(projectRoot, 'src/main/ipc/parcel-watcher-process-entry.ts')],
      outfile: join(bundleDir, 'relay-watcher.js'),
      external: ['@parcel/watcher']
    }),
    build({
      ...common,
      entryPoints: [join(projectRoot, 'src/relay/ai-vault-service-entry.ts')],
      outfile: join(bundleDir, 'relay-ai-vault-service.js'),
      external: ['electron']
    }),
    build({
      ...common,
      entryPoints: [join(projectRoot, 'src/main/agent-hooks/managed-hook-runtime.ts')],
      outfile: join(bundleDir, 'managed-hook-runtime.js'),
      alias: {
        'jsonc-parser': join(projectRoot, 'node_modules/jsonc-parser/lib/esm/main.js')
      }
    })
  ])
}, 30_000)

afterAll(async () => {
  if (bundleDir) {
    await rm(bundleDir, { recursive: true, force: true })
  }
})

describe.skipIf(!bunAvailable)('Bun relay companion processes', () => {
  it('keeps watcher events and AI Vault IPC working through Bun child processes', async () => {
    const socketDir = mkdtempSync(join(tmpdir(), 'relay-bun-companion-sock-'))
    const watchRoot = join(socketDir, 'watched')
    mkdirSync(watchRoot)
    const socketPath = relayTestSocketPath(socketDir)
    const credentialFile = join(socketDir, 'credential')
    writeFileSync(credentialFile, 'bun-relay-companion-credential-0123456789abcdef')
    let daemon: RelayProcess | null = null
    let bridge: RelayProcess | null = null
    try {
      daemon = spawnRelay(
        relayEntry,
        [
          '--detached',
          '--grace-time',
          '30',
          '--sock-path',
          socketPath,
          '--endpoint-dir',
          join(socketDir, 'agent-hooks'),
          '--credential-file',
          credentialFile
        ],
        { runtime: bunExecutable }
      )
      await daemon.sentinelReceived
      bridge = spawnRelay(relayEntry, [
        '--connect',
        '--sock-path',
        socketPath,
        '--credential-file',
        credentialFile
      ])
      await bridge.sentinelReceived

      const titles = await bridge.waitForResponse(
        bridge.send('aiVault.resolveSessionTitles', { requests: [] })
      )
      expect(titles.error).toBeUndefined()
      expect(titles.result).toEqual({ titles: [] })

      const hooks = await bridge.waitForResponse(
        bridge.send('agent_hook.installManagedHooks', { agents: [] })
      )
      expect(hooks.error).toBeUndefined()
      expect(hooks.result).toEqual({ installers: 0, errors: 0 })

      const watch = await bridge.waitForResponse(
        bridge.send('fs.watch', { rootPath: watchRoot, watchId: 1 }),
        10_000
      )
      expect(watch.error).toBeUndefined()
      const createdPath = join(watchRoot, 'from-bun-companion.txt')
      writeFileSync(createdPath, 'observed')
      const changed = await bridge.waitForNotification('fs.changed', 10_000)
      expect(changed.params).toMatchObject({
        events: expect.arrayContaining([
          expect.objectContaining({ kind: 'create', absolutePath: createdPath })
        ])
      })

      const unwatch = await bridge.waitForResponse(
        bridge.send('fs.unwatchAndWait', { rootPath: watchRoot }),
        10_000
      )
      expect(unwatch.error).toBeUndefined()
      const status = await bridge.waitForResponse(bridge.send('relay.status'))
      expect(status.result).toMatchObject({ runtimeKind: 'bun', ptyBackend: 'bun-terminal' })
    } finally {
      bridge?.kill('SIGTERM')
      await bridge?.waitForExit().catch(() => undefined)
      daemon?.kill('SIGTERM')
      await daemon?.waitForExit().catch(() => undefined)
      await rm(socketDir, { recursive: true, force: true })
    }
  }, 30_000)
})
