import { existsSync as nodeExistsSync } from 'fs'
import path from 'path'
import { homedir, userInfo } from 'os'
import type { DockerEngineInfo } from './types'

type DetectOptions = {
  platform?: NodeJS.Platform
  env?: NodeJS.ProcessEnv
  uid?: number
  existsSync?: (candidate: string) => boolean
}

export function detectDockerEngine(options: DetectOptions = {}): DockerEngineInfo {
  const platform = options.platform ?? process.platform
  const env = options.env ?? process.env
  const existsSync = options.existsSync ?? nodeExistsSync
  const home = env.HOME ?? env.USERPROFILE ?? homedir()

  if (platform === 'darwin') {
    const colimaSocket = path.join(home, '.colima', 'default', 'docker.sock')
    if (existsSync(colimaSocket)) {
      return {
        flavor: 'colima',
        socketPath: colimaSocket,
        available: true
      }
    }

    const desktopSocket = path.join(path.sep, 'var', 'run', 'docker.sock')
    if (existsSync(desktopSocket)) {
      return {
        flavor: 'docker-desktop-mac',
        socketPath: desktopSocket,
        available: true
      }
    }

    return {
      flavor: 'docker-desktop-mac',
      socketPath: desktopSocket,
      available: false,
      reason: 'Docker Desktop or Colima socket was not found'
    }
  }

  if (platform === 'linux') {
    const engineSocket = path.join(path.sep, 'var', 'run', 'docker.sock')
    if (existsSync(engineSocket)) {
      return {
        flavor: 'docker-engine-linux',
        socketPath: engineSocket,
        available: true
      }
    }

    const uid = options.uid ?? safeUid()
    const rootlessSocket = path.join(path.sep, 'run', 'user', String(uid), 'docker.sock')
    if (existsSync(rootlessSocket)) {
      return {
        flavor: 'docker-rootless-linux',
        socketPath: rootlessSocket,
        available: true
      }
    }

    return {
      flavor: 'docker-engine-linux',
      socketPath: engineSocket,
      available: false,
      reason: 'Docker Engine socket was not found'
    }
  }

  if (platform === 'win32') {
    const pipeName = String.raw`\\.\pipe\docker_engine`
    if (existsSync(pipeName)) {
      return {
        flavor: 'docker-desktop-windows-wsl2',
        socketPath: pipeName,
        available: true
      }
    }

    return {
      flavor: 'docker-desktop-windows-wsl2',
      socketPath: pipeName,
      available: false,
      reason: 'Docker Desktop WSL2 named pipe was not found'
    }
  }

  return {
    flavor: 'docker-engine-linux',
    socketPath: '',
    available: false,
    reason: `Unsupported platform: ${platform}`
  }
}

function safeUid(): number {
  try {
    return userInfo().uid
  } catch {
    return 0
  }
}
