import { createServer } from 'net';
export class SshPortForwardManager {
    forwards = new Map();
    nextId = 1;
    async addForward(connectionId, conn, localPort, remoteHost, remotePort, label) {
        const id = `pf-${this.nextId++}`;
        const entry = {
            id,
            connectionId,
            localPort,
            remoteHost,
            remotePort,
            label
        };
        const client = conn.getClient();
        if (!client) {
            throw new Error('SSH connection is not established');
        }
        const activeSockets = new Set();
        const server = createServer((socket) => {
            activeSockets.add(socket);
            socket.on('close', () => activeSockets.delete(socket));
            client.forwardOut('127.0.0.1', localPort, remoteHost, remotePort, (err, channel) => {
                if (err) {
                    socket.destroy();
                    return;
                }
                socket.pipe(channel).pipe(socket);
                channel.on('close', () => socket.destroy());
                socket.on('close', () => channel.close());
            });
        });
        await new Promise((resolve, reject) => {
            server.on('error', reject);
            server.listen(localPort, '127.0.0.1', () => {
                server.removeListener('error', reject);
                resolve();
            });
        });
        this.forwards.set(id, { entry, server, activeSockets });
        return entry;
    }
    removeForward(id) {
        const forward = this.forwards.get(id);
        if (!forward) {
            return false;
        }
        for (const socket of forward.activeSockets) {
            socket.destroy();
        }
        forward.server.close();
        this.forwards.delete(id);
        return true;
    }
    listForwards(connectionId) {
        const entries = [];
        for (const { entry } of this.forwards.values()) {
            if (!connectionId || entry.connectionId === connectionId) {
                entries.push(entry);
            }
        }
        return entries;
    }
    removeAllForwards(connectionId) {
        // Why: removeForward deletes from this.forwards. Collecting IDs first
        // avoids mutating the map during iteration, which is fragile if
        // removeForward ever gains cascading cleanup.
        const toRemove = [...this.forwards.entries()]
            .filter(([, { entry }]) => entry.connectionId === connectionId)
            .map(([id]) => id);
        for (const id of toRemove) {
            this.removeForward(id);
        }
    }
    dispose() {
        const ids = [...this.forwards.keys()];
        for (const id of ids) {
            this.removeForward(id);
        }
    }
}
