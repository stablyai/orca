import { build } from 'esbuild'

export type DaemonSessionClientResult = { pid: number; isReattach: boolean; output: boolean }

/** Run bundled client with Node: <create|attach> <daemonDir> <sessionId> <marker> <cwd>. */
export async function buildDaemonSessionClient(outfile: string): Promise<void> {
  await build({
    stdin: {
      contents: `\n        import { DaemonPtyAdapter } from './src/main/daemon/providers/adapter/daemon-pty-adapter'\n        import { getDaemonPidPath, getDaemonSocketPath, getDaemonTokenPath } from './src/main/daemon/launch/daemon-spawner'\n        import { setAppEnvironment } from './src/shared/app-environment'\n        const [op, runtimeDir, sessionId, marker, cwd] = process.argv.slice(2)\n        setAppEnvironment({\n          getPath: () => cwd, getAppPath: () => cwd, getVersion: () => 'test', isPackaged: () => true,\n          onWillQuit() {}, exit: code => process.exit(code), getAppMetrics: () => []\n        })\n        const adapter = new DaemonPtyAdapter({\n          socketPath: getDaemonSocketPath(runtimeDir), tokenPath: getDaemonTokenPath(runtimeDir),\n          pidPath: getDaemonPidPath(runtimeDir), profileScope: runtimeDir, runtimeDir\n        })\n        let output = ''\n        adapter.onData(event => { if (event.id === sessionId) output += event.data })\n        const deadline = setTimeout(() => { console.error('timed out; output: ' + output); process.exit(98) }, 20_000)\n        ;(async () => {\n          const win32 = process.platform === 'win32'\n          const spawned = await adapter.spawn(op === 'create'\n            ? { sessionId, cols: 80, rows: 24, cwd, shellOverride: win32 ? 'cmd.exe' : '/bin/sh' }\n            : { sessionId, cols: 80, rows: 24 })\n          // Both shells echo what is typed, so the typed form must not already read as the marker.\n          const typed = win32 ? 'echo ORCA_^SERVE_' + marker : "printf 'ORCA_SERVE_%s\\\\n' " + marker\n          adapter.write(spawned.id, typed + "\\r")\n          while (!output.includes('ORCA_SERVE_' + marker)) await new Promise(r => setTimeout(r, 50))\n          clearTimeout(deadline)\n          await adapter.disconnectOnly()\n          console.log(JSON.stringify({ pid: spawned.pid, isReattach: spawned.isReattach === true, output: true }))\n          process.exit(0)\n        })().catch(error => { console.error(error); process.exit(1) })\n      `,
      resolveDir: process.cwd(),
      loader: 'ts'
    },
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node18',
    external: ['electron', 'node-pty', '@parcel/watcher', '*.node'],
    outfile,
    logLevel: 'silent'
  })
}
