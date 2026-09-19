import { build } from 'esbuild'
import { join, resolve } from 'node:path'

export async function buildRelaySubprocessBundle(bundleDir: string): Promise<string> {
  const relayEntry = join(bundleDir, 'relay.js')
  await build({
    entryPoints: [resolve(__dirname, 'relay.ts')],
    bundle: true,
    platform: 'node',
    target: 'node18',
    format: 'cjs',
    outfile: relayEntry,
    external: ['node-pty', '@parcel/watcher', 'electron'],
    sourcemap: false
  })
  await build({
    entryPoints: [resolve(__dirname, '../main/ipc/parcel-watcher-process-entry.ts')],
    bundle: true,
    platform: 'node',
    target: 'node18',
    format: 'cjs',
    outfile: join(bundleDir, 'relay-watcher.js'),
    external: ['@parcel/watcher'],
    sourcemap: false
  })
  return relayEntry
}
