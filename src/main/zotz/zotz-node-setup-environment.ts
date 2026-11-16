import type { ZotzProcessRunner } from './zotz-process-runner'

/** Everything the platform phases touch, injected so the sequencing can be tested off-platform. */
export type ZotzNodeSetupEnvironment = {
  platform: NodeJS.Platform
  env: NodeJS.ProcessEnv
  run: ZotzProcessRunner
  exists: (path: string) => Promise<boolean>
  readText: (path: string) => Promise<string | null>
  writeFile: (path: string, data: string | Buffer) => Promise<void>
  removeFile: (path: string) => Promise<void>
  /** Dev builds point at a transient Electron binary that must not be persisted in autostart. */
  isPackaged: boolean
  executablePath: string
  homeDir: string
  userDataPath: string
  username: string
  port: number
  setupScriptPath: string | null
  ensureNetworkExposure: () => Promise<void>
  isKeptAwake: () => boolean
  sleep: (ms: number) => Promise<void>
  now: () => number
  tailscaleWaitMs: number
}
