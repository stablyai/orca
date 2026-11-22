import { dirname, join, resolve } from 'node:path'
import { mkdir } from 'node:fs/promises'
import { setAppEnvironment } from '../../shared/app-lifecycle/app-environment'
import { createNodeServiceEnvironment } from '../backend/node-service-environment'
import {
  parseExternalAcpProfileArgs,
  readExternalAcpProfile
} from './external-gateway/external-acp-profile.mjs'
import { runExternalAcpLauncher } from './external-gateway/external-acp-launcher.mjs'

async function prepareProfileEnvironment(home: string): Promise<string> {
  const entryPath = process.argv[1]
  if (!entryPath) {
    throw new Error('External ACP launcher entry path is missing')
  }
  const data = join(home, 'host-state')
  await mkdir(data, { recursive: true, mode: 0o700 })
  const { environment } = createNodeServiceEnvironment({
    getPath: (name) => (name === 'exe' ? process.execPath : data),
    getAppPath: () => resolve(dirname(entryPath), '../..'),
    getVersion: () => 'external-acp-launcher',
    isPackaged: () => process.resourcesPath !== undefined,
    getCliLauncherPath: () => null
  })
  setAppEnvironment(environment)
  return data
}

void (async () => {
  const profile = await readExternalAcpProfile(parseExternalAcpProfileArgs(process.argv.slice(2)))
  await prepareProfileEnvironment(profile.nativeHome)
  await runExternalAcpLauncher(profile)
})().catch((error) => {
  const label =
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    typeof error.code === 'string' &&
    /^[A-Z0-9_]{2,32}$/.test(error.code)
      ? error.code
      : error instanceof Error
        ? error.name
        : 'Error'
  process.stderr.write(`External ACP launcher could not be started: ${label}\n`)
  process.exitCode = 1
})
