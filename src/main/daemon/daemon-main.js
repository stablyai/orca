import { DaemonServer } from './daemon-server';
export async function startDaemon(opts) {
    const server = new DaemonServer({
        socketPath: opts.socketPath,
        tokenPath: opts.tokenPath,
        spawnSubprocess: opts.spawnSubprocess
    });
    await server.start();
    return {
        shutdown: () => server.shutdown()
    };
}
