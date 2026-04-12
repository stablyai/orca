import { app, BrowserWindow } from 'electron'
import { randomUUID } from 'crypto'
import { createServer, type IncomingMessage, type ServerResponse } from 'http'
import { join } from 'path'
import { mkdirSync, writeFileSync } from 'fs'
import type { OpenCodeStatusEvent } from '../../shared/types'

const ORCA_OPENCODE_PLUGIN_FILE = 'orca-opencode-status.js'

type OpenCodeHookStatus = OpenCodeStatusEvent['status']

function readJsonBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let body = ''
    req.on('data', (chunk: Buffer) => {
      body += chunk.toString()
      if (body.length > 1_000_000) {
        reject(new Error('payload too large'))
        req.destroy()
      }
    })
    req.on('end', () => {
      try {
        resolve(body ? JSON.parse(body) : {})
      } catch (error) {
        reject(error)
      }
    })
    req.on('error', reject)
  })
}

function normalizeStatus(value: unknown): OpenCodeHookStatus | null {
  return value === 'working' || value === 'idle' || value === 'permission' ? value : null
}

function getOpenCodePluginSource(): string {
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
  ].join('\n')
}

export class OpenCodeHookService {
  private server: ReturnType<typeof createServer> | null = null
  private port = 0
  private token = ''
  private lastStatusByPtyId = new Map<string, OpenCodeHookStatus>()

  async start(): Promise<void> {
    if (this.server) {
      return
    }

    this.token = randomUUID()
    this.server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
      if (req.method !== 'POST' || req.url !== '/hook') {
        res.writeHead(404)
        res.end()
        return
      }

      if (req.headers['x-orca-token'] !== this.token) {
        res.writeHead(403)
        res.end()
        return
      }

      const ptyIdHeader = req.headers['x-orca-opencode-pty-id']
      const ptyId = Array.isArray(ptyIdHeader) ? ptyIdHeader[0] : ptyIdHeader
      if (!ptyId) {
        res.writeHead(400)
        res.end()
        return
      }

      try {
        const body = await readJsonBody(req)
        const status = normalizeStatus((body as { status?: unknown }).status)
        if (!status) {
          res.writeHead(400)
          res.end()
          return
        }

        if (this.lastStatusByPtyId.get(ptyId) !== status) {
          this.lastStatusByPtyId.set(ptyId, status)
          const payload: OpenCodeStatusEvent = { ptyId, status }
          for (const window of BrowserWindow.getAllWindows()) {
            if (!window.isDestroyed()) {
              window.webContents.send('pty:opencode-status', payload)
            }
          }
        }

        res.writeHead(204)
        res.end()
      } catch {
        res.writeHead(400)
        res.end()
      }
    })

    await new Promise<void>((resolve, reject) => {
      this.server!.once('error', reject)
      this.server!.listen(0, '127.0.0.1', () => {
        const address = this.server!.address()
        if (address && typeof address === 'object') {
          this.port = address.port
        }
        resolve()
      })
    })
  }

  stop(): void {
    this.server?.close()
    this.server = null
    this.port = 0
    this.lastStatusByPtyId.clear()
  }

  clearPty(ptyId: string): void {
    this.lastStatusByPtyId.delete(ptyId)
  }

  buildPtyEnv(ptyId: string): Record<string, string> {
    if (this.port <= 0 || !this.token) {
      return {}
    }

    const configDir = this.writePluginConfig(ptyId)

    // Why: OpenCode only reads the extra plugin directory at process startup.
    // Inject these vars into every Orca PTY so manually launched `opencode`
    // sessions inherit the hook path too, not just sessions started from a
    // hardcoded Orca command template.
    return {
      ORCA_OPENCODE_HOOK_PORT: String(this.port),
      ORCA_OPENCODE_HOOK_TOKEN: this.token,
      ORCA_OPENCODE_PTY_ID: ptyId,
      OPENCODE_CONFIG_DIR: configDir
    }
  }

  private writePluginConfig(ptyId: string): string {
    const configDir = join(app.getPath('userData'), 'opencode-hooks', ptyId)
    const pluginsDir = join(configDir, 'plugins')
    mkdirSync(pluginsDir, { recursive: true })
    writeFileSync(join(pluginsDir, ORCA_OPENCODE_PLUGIN_FILE), getOpenCodePluginSource())
    return configDir
  }
}

export const openCodeHookService = new OpenCodeHookService()
