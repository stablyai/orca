import { app, ipcMain, type IpcMainInvokeEvent } from 'electron'
import { access, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { homedir, userInfo } from 'node:os'
import { dirname, join } from 'node:path'
import type { ZotzNodeSetupResult } from '../../shared/zotz/zotz-node-setup-contract'
import type { AgentAwakeService } from '../power/agent-awake-service'
import type { OrcaRuntimeRpcServer } from '../runtime/rpc/server/runtime-rpc'
import { getWebSocketPort } from '../runtime/rpc/server/pairing/network/windows-mobile-firewall'
import { DEFAULT_WS_PORT } from '../runtime/rpc/server/runtime-rpc-pairing-types'
import { removeZotzDesktopAutostart } from './zotz-desktop-autostart-removal'
import type { ZotzNodeSetupEnvironment } from './zotz-node-setup-environment'
import { runZotzNodeSetup } from './zotz-node-setup-orchestrator'
import { buildZotzNodeSetupPhases } from './zotz-node-setup-phases'
import { runZotzProcess } from './zotz-process-runner'

type ZotzNodeSetupHandlerDeps = {
  getRuntimeRpc: () => OrcaRuntimeRpcServer | null
  getAgentAwakeService: () => AgentAwakeService | null
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}

async function resolveSetupScriptPath(): Promise<string | null> {
  for (const candidate of [
    join(process.resourcesPath ?? '', 'zotz', 'zotz-node-setup.ps1'),
    join(app.getAppPath(), 'scripts', 'windows', 'zotz-node-setup.ps1')
  ]) {
    if (await pathExists(candidate)) {
      return candidate
    }
  }
  return null
}

async function readText(path: string): Promise<string | null> {
  try {
    return await readFile(path, 'utf8')
  } catch {
    return null
  }
}

async function createEnvironment(
  deps: ZotzNodeSetupHandlerDeps
): Promise<ZotzNodeSetupEnvironment> {
  const runtimeRpc = deps.getRuntimeRpc()
  return {
    platform: process.platform,
    env: process.env,
    run: runZotzProcess,
    exists: pathExists,
    readText,
    writeFile: async (path, data) => {
      await mkdir(dirname(path), { recursive: true })
      await writeFile(path, data)
    },
    removeFile: (path) => rm(path, { force: true }),
    isPackaged: app.isPackaged,
    executablePath: process.execPath,
    homeDir: homedir(),
    userDataPath: app.getPath('userData'),
    username: userInfo().username,
    port: getWebSocketPort(runtimeRpc?.getWebSocketEndpoint() ?? null) ?? DEFAULT_WS_PORT,
    setupScriptPath: process.platform === 'win32' ? await resolveSetupScriptPath() : null,
    ensureNetworkExposure: async () => {
      if (!runtimeRpc) {
        throw new Error('the runtime server is not running')
      }
      await runtimeRpc.ensureNetworkExposure()
    },
    isKeptAwake: () => deps.getAgentAwakeService()?.getStatus().active === true,
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    now: Date.now,
    tailscaleWaitMs: 10 * 60_000
  }
}

// Only the app's own windows may trigger installers and admin prompts.
function isWindowRenderer(event: IpcMainInvokeEvent): boolean {
  return !event.sender.isDestroyed() && event.sender.getType() === 'window'
}

export function registerZotzNodeSetupHandlers(deps: ZotzNodeSetupHandlerDeps): void {
  let inFlight: Promise<ZotzNodeSetupResult> | null = null
  ipcMain.handle('zotzNode:runServerSetup', (event) => {
    if (!isWindowRenderer(event)) {
      throw new Error('zotz node setup is only available from a desktop window')
    }
    if (!inFlight) {
      const sender = event.sender
      inFlight = createEnvironment(deps)
        .then((environment) =>
          runZotzNodeSetup(buildZotzNodeSetupPhases(environment), (steps) => {
            if (!sender.isDestroyed()) {
              sender.send('zotzNode:setupProgress', steps)
            }
          })
        )
        .finally(() => {
          inFlight = null
        })
    }
    return inFlight
  })
  ipcMain.handle('zotzNode:removeAutostart', (event) => {
    if (!isWindowRenderer(event)) {
      throw new Error('zotz node setup is only available from a desktop window')
    }
    return createEnvironment(deps).then(removeZotzDesktopAutostart)
  })
}
