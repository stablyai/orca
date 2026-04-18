import { Session } from './session';
import { SessionNotFoundError } from './types';
const MAX_TOMBSTONES = 1000;
export class TerminalHost {
    sessions = new Map();
    killedTombstones = new Map();
    spawnSubprocess;
    constructor(opts) {
        this.spawnSubprocess = opts.spawnSubprocess;
    }
    async createOrAttach(opts) {
        const existing = this.sessions.get(opts.sessionId);
        if (existing && existing.isAlive) {
            const snapshot = existing.getSnapshot();
            existing.detachAllClients();
            const token = existing.attachClient(opts.streamClient);
            return {
                isNew: false,
                snapshot,
                pid: existing.pid,
                shellState: existing.shellState,
                attachToken: token
            };
        }
        // Clean up dead session if present
        if (existing) {
            existing.dispose();
            this.sessions.delete(opts.sessionId);
        }
        // Clear tombstone if re-creating a killed session
        this.killedTombstones.delete(opts.sessionId);
        const subprocess = this.spawnSubprocess({
            sessionId: opts.sessionId,
            cols: opts.cols,
            rows: opts.rows,
            cwd: opts.cwd,
            env: opts.env,
            command: opts.command
        });
        const session = new Session({
            sessionId: opts.sessionId,
            cols: opts.cols,
            rows: opts.rows,
            subprocess,
            shellReadySupported: opts.shellReadySupported ?? false
        });
        this.sessions.set(opts.sessionId, session);
        const token = session.attachClient(opts.streamClient);
        if (opts.command) {
            // Why: startup commands must run inside the long-lived interactive shell
            // the daemon keeps for the pane. Session.write() handles the shell-ready
            // barrier for supported shells and falls back to an immediate write for
            // unsupported ones.
            session.write(opts.command.endsWith('\n') ? opts.command : `${opts.command}\n`);
        }
        return {
            isNew: true,
            snapshot: null,
            pid: subprocess.pid,
            shellState: session.shellState,
            attachToken: token
        };
    }
    write(sessionId, data) {
        this.getAliveSession(sessionId).write(data);
    }
    resize(sessionId, cols, rows) {
        this.getAliveSession(sessionId).resize(cols, rows);
    }
    kill(sessionId) {
        const session = this.getAliveSession(sessionId);
        this.recordTombstone(sessionId);
        session.kill();
    }
    signal(sessionId, sig) {
        this.getAliveSession(sessionId).signal(sig);
    }
    detach(sessionId, token) {
        const session = this.sessions.get(sessionId);
        session?.detachClient(token);
    }
    getCwd(sessionId) {
        return this.getAliveSession(sessionId).getCwd();
    }
    clearScrollback(sessionId) {
        this.getAliveSession(sessionId).clearScrollback();
    }
    isKilled(sessionId) {
        return this.killedTombstones.has(sessionId);
    }
    listSessions() {
        const result = [];
        for (const [, session] of this.sessions) {
            if (!session.isAlive) {
                continue;
            }
            const snapshot = session.getSnapshot();
            result.push({
                sessionId: session.sessionId,
                state: session.state,
                shellState: session.shellState,
                isAlive: true,
                pid: session.pid,
                cwd: session.getCwd(),
                cols: snapshot?.cols ?? 0,
                rows: snapshot?.rows ?? 0,
                createdAt: 0
            });
        }
        return result;
    }
    dispose() {
        for (const [, session] of this.sessions) {
            session.detachAllClients();
            session.kill();
        }
        this.sessions.clear();
        this.killedTombstones.clear();
    }
    getAliveSession(sessionId) {
        const session = this.sessions.get(sessionId);
        if (!session || !session.isAlive) {
            throw new SessionNotFoundError(sessionId);
        }
        return session;
    }
    recordTombstone(sessionId) {
        this.killedTombstones.delete(sessionId);
        this.killedTombstones.set(sessionId, Date.now());
        if (this.killedTombstones.size > MAX_TOMBSTONES) {
            const oldest = this.killedTombstones.keys().next().value;
            if (oldest) {
                this.killedTombstones.delete(oldest);
            }
        }
    }
}
