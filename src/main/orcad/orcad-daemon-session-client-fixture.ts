// Test fixture: a terminal client that talks to a profile's terminal daemon directly, the way a
// paired client's terminal does, so a test can prove a session outlives a serve-host switch.
import { build } from 'esbuild'

export type DaemonSessionClientResult = { pid: number; isReattach: boolean; output: boolean }

/** Bundles the client to `outfile`; run it with Node as `<op: create|attach> <daemonDir> <sessionId> <marker> <cwd>`. */
export async function buildDaemonSessionClient(outfile: string): Promise<void> {
  await build({
    stdin: {
      contents: `
        import { DaemonPtyAdapter } from './src/main/daemon/daemon-pty-adapter'
        import { getDaemonPidPath, getDaemonSocketPath, getDaemonTokenPath } from './src/main/daemon/daemon-spawner'
        import { setAppEnvironment } from './src/shared/app-environment'
        const [op, runtimeDir, sessionId, marker, cwd] = process.argv.slice(2)
        setAppEnvironment({
          getPath: () => cwd, getAppPath: () => cwd, getVersion: () => 'test', isPackaged: () => true,
          onWillQuit() {}, exit: code => process.exit(code), getAppMetrics: () => []
        })
        const adapter = new DaemonPtyAdapter({
          socketPath: getDaemonSocketPath(runtimeDir), tokenPath: getDaemonTokenPath(runtimeDir),
          pidPath: getDaemonPidPath(runtimeDir), profileScope: runtimeDir, runtimeDir
        })
        let output = ''
        adapter.onData(event => { if (event.id === sessionId) output += event.data })
        const deadline = setTimeout(() => { console.error('timed out; output: ' + output); process.exit(98) }, 20_000)
        ;(async () => {
          const win32 = process.platform === 'win32'
          const spawned = await adapter.spawn(op === 'create'
            ? { sessionId, cols: 80, rows: 24, cwd, shellOverride: win32 ? 'cmd.exe' : '/bin/sh' }
            : { sessionId, cols: 80, rows: 24 })
          // Both shells echo what is typed, so the typed form must not already read as the marker.
          const typed = win32 ? 'echo ORCA_^SERVE_' + marker : "printf 'ORCA_SERVE_%s\\\\n' " + marker
          adapter.write(spawned.id, typed + "\\r")
          while (!output.includes('ORCA_SERVE_' + marker)) await new Promise(r => setTimeout(r, 50))
          clearTimeout(deadline)
          await adapter.disconnectOnly()
          console.log(JSON.stringify({ pid: spawned.pid, isReattach: spawned.isReattach === true, output: true }))
          process.exit(0)
        })().catch(error => { console.error(error); process.exit(1) })
      `,
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
