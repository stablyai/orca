import { app, BrowserWindow } from 'electron';
import { randomUUID } from 'crypto';
import { createServer } from 'http';
import { join } from 'path';
import { mkdirSync, writeFileSync, rmSync } from 'fs';
const ORCA_OPENCODE_PLUGIN_FILE = 'orca-opencode-status.js';
function readJsonBody(req) {
    return new Promise((resolve, reject) => {
        let body = '';
        req.on('data', (chunk) => {
            body += chunk.toString();
            if (body.length > 1_000_000) {
                reject(new Error('payload too large'));
                req.destroy();
            }
        });
        req.on('end', () => {
            try {
                resolve(body ? JSON.parse(body) : {});
            }
            catch (error) {
                reject(error);
            }
        });
        req.on('error', reject);
    });
}
function normalizeStatus(value) {
    return value === 'working' || value === 'idle' || value === 'permission' ? value : null;
}
function getOpenCodePluginSource() {
    return [
        'const HOOK_PATH = "/hook";',
        '',
        'function getHookUrl() {',
        '  const port = process.env.ORCA_OPENCODE_HOOK_PORT;',
        '  return port ? `http://127.0.0.1:${port}${HOOK_PATH}` : null;',
        '}',
        '',
        'function getStatusType(event) {',
        '  return event?.properties?.status?.type ?? event?.status?.type ?? null;',
        '}',
        '',
        'async function postStatus(status) {',
        '  const url = getHookUrl();',
        '  const token = process.env.ORCA_OPENCODE_HOOK_TOKEN;',
        '  const ptyId = process.env.ORCA_OPENCODE_PTY_ID;',
        '  if (!url || !token || !ptyId) return;',
        '  try {',
        '    await fetch(url, {',
        '      method: "POST",',
        '      headers: {',
        '        "Content-Type": "application/json",',
        '        "X-Orca-Token": token,',
        '        "X-Orca-OpenCode-Pty-Id": ptyId,',
        '      },',
        '      body: JSON.stringify({ status }),',
        '    });',
        '  } catch {',
        '    // Why: OpenCode session hooks must never fail the agent run just',
        '    // because Orca is unavailable or the local loopback request failed.',
        '  }',
        '}',
        '',
        'export const OrcaOpenCodeStatusPlugin = async () => ({',
        '  event: async ({ event }) => {',
        '    if (!event?.type) return;',
        '',
        '    if (event.type === "permission.asked") {',
        '      await postStatus("permission");',
        '      return;',
        '    }',
        '',
        '    if (event.type === "session.idle") {',
        '      await postStatus("idle");',
        '      return;',
        '    }',
        '',
        '    if (event.type === "session.status") {',
        '      const statusType = getStatusType(event);',
        '      if (statusType === "busy" || statusType === "retry") {',
        '        await postStatus("working");',
        '        return;',
        '      }',
        '      if (statusType === "idle") {',
        '        await postStatus("idle");',
        '      }',
        '    }',
        '  },',
        '});',
        ''
    ].join('\n');
}
export class OpenCodeHookService {
    server = null;
    port = 0;
    token = '';
    lastStatusByPtyId = new Map();
    async start() {
        if (this.server) {
            return;
        }
        this.token = randomUUID();
        this.server = createServer(async (req, res) => {
            if (req.method !== 'POST' || req.url !== '/hook') {
                res.writeHead(404);
                res.end();
                return;
            }
            if (req.headers['x-orca-token'] !== this.token) {
                res.writeHead(403);
                res.end();
                return;
            }
            const ptyIdHeader = req.headers['x-orca-opencode-pty-id'];
            const ptyId = Array.isArray(ptyIdHeader) ? ptyIdHeader[0] : ptyIdHeader;
            if (!ptyId) {
                res.writeHead(400);
                res.end();
                return;
            }
            try {
                const body = await readJsonBody(req);
                const status = normalizeStatus(body.status);
                if (!status) {
                    res.writeHead(400);
                    res.end();
                    return;
                }
                if (this.lastStatusByPtyId.get(ptyId) !== status) {
                    this.lastStatusByPtyId.set(ptyId, status);
                    const payload = { ptyId, status };
                    for (const window of BrowserWindow.getAllWindows()) {
                        if (!window.isDestroyed()) {
                            window.webContents.send('pty:opencode-status', payload);
                        }
                    }
                }
                res.writeHead(204);
                res.end();
            }
            catch {
                res.writeHead(400);
                res.end();
            }
        });
        await new Promise((resolve, reject) => {
            this.server.once('error', reject);
            this.server.listen(0, '127.0.0.1', () => {
                const address = this.server.address();
                if (address && typeof address === 'object') {
                    this.port = address.port;
                }
                resolve();
            });
        });
    }
    stop() {
        this.server?.close();
        this.server = null;
        this.port = 0;
        // Why: clean up all remaining PTY config directories before clearing the
        // in-memory tracking. Without this, directories from the current session's
        // PTYs survive on disk after shutdown.
        for (const ptyId of this.lastStatusByPtyId.keys()) {
            const configDir = join(app.getPath('userData'), 'opencode-hooks', ptyId);
            try {
                rmSync(configDir, { recursive: true, force: true });
            }
            catch {
                // best-effort
            }
        }
        this.lastStatusByPtyId.clear();
    }
    clearPty(ptyId) {
        this.lastStatusByPtyId.delete(ptyId);
        // Why: writePluginConfig creates a directory per PTY under userData. Without
        // cleanup these accumulate across sessions since ptyId is a monotonically
        // increasing counter. Remove the directory when the PTY is torn down.
        const configDir = join(app.getPath('userData'), 'opencode-hooks', ptyId);
        try {
            rmSync(configDir, { recursive: true, force: true });
        }
        catch {
            // Why: best-effort cleanup. The directory may already be gone if the user
            // manually purged userData, or the OS may hold a lock briefly.
        }
    }
    buildPtyEnv(ptyId) {
        if (this.port <= 0 || !this.token) {
            return {};
        }
        const configDir = this.writePluginConfig(ptyId);
        // Why: OpenCode only reads the extra plugin directory at process startup.
        // Inject these vars into every Orca PTY so manually launched `opencode`
        // sessions inherit the hook path too, not just sessions started from a
        // hardcoded Orca command template.
        return {
            ORCA_OPENCODE_HOOK_PORT: String(this.port),
            ORCA_OPENCODE_HOOK_TOKEN: this.token,
            ORCA_OPENCODE_PTY_ID: ptyId,
            OPENCODE_CONFIG_DIR: configDir
        };
    }
    writePluginConfig(ptyId) {
        const configDir = join(app.getPath('userData'), 'opencode-hooks', ptyId);
        const pluginsDir = join(configDir, 'plugins');
        mkdirSync(pluginsDir, { recursive: true });
        writeFileSync(join(pluginsDir, ORCA_OPENCODE_PLUGIN_FILE), getOpenCodePluginSource());
        return configDir;
    }
}
export const openCodeHookService = new OpenCodeHookService();
