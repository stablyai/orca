import { SERVE_SUPERVISOR_ENV } from '../../shared/serve-supervision'
import { reconcileSingletonQuarantines } from './serve-singleton-quarantine'

export async function prepareLinuxServeSupervision(
  userDataPath: string,
  tempDirectory: string,
  childEnv: NodeJS.ProcessEnv
): Promise<void> {
  await reconcileSingletonQuarantines(userDataPath, tempDirectory)
  childEnv[SERVE_SUPERVISOR_ENV] = '1'
}
