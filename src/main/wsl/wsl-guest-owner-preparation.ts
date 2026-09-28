import { readWslDistributionIdentity } from './wsl-distribution-identity'
import { parseOrcadLinuxLibc } from '../ssh/orcad-deployment-target'
import {
  assertWslRuntimeDistroRunning,
  createRunningWslRuntimeRunner,
  ensureWslBunRuntime
} from './wsl-bun-runtime'
import { getWslGuestEnvironment, invalidateWslGuestEnvironment } from './wsl-guest-environment'

/** Capture the default user once; every later probe and install runs as that owner. */
export async function prepareWslGuestOwner(distro: string, signal?: AbortSignal) {
  const distributionId = await readWslDistributionIdentity(distro)
  const initial = createRunningWslRuntimeRunner(distro, signal)
  const userName = await initial.run({ program: 'id', args: ['-un'], loginPath: 'none' })
  if (!userName || /[\0\r\n]/.test(userName)) {
    throw new Error('Invalid WSL guest user')
  }
  const execution = createRunningWslRuntimeRunner(distro, signal, userName)
  const architecture = await execution.run({ program: 'uname', args: ['-m'], loginPath: 'none' })
  if (!['x86_64', 'aarch64', 'arm64'].includes(architecture)) {
    throw new Error(`Unsupported WSL architecture: ${architecture}`)
  }
  const platform: 'linux-x64' | 'linux-arm64' =
    architecture === 'x86_64' ? 'linux-x64' : 'linux-arm64'
  const libc = parseOrcadLinuxLibc(
    await execution.run({
      script:
        'getconf GNU_LIBC_VERSION 2>/dev/null || ldd --version 2>&1 || for loader in /lib/ld-musl-*.so.1; do [ ! -e "$loader" ] || { echo musl; break; }; done',
      loginPath: 'none'
    })
  )
  const runtime = await ensureWslBunRuntime(execution)
  await assertWslRuntimeDistroRunning(distro, execution.signal)
  invalidateWslGuestEnvironment(distro)
  const environment = await getWslGuestEnvironment(distro, undefined, userName)
  execution.signal.throwIfAborted()
  if (!environment) {
    throw new Error('WSL login environment is unavailable')
  }
  const userId = await execution.run({ program: 'id', args: ['-u'], loginPath: 'none' })
  if (!/^\d+$/.test(userId)) {
    throw new Error('WSL guest user could not be verified')
  }
  if ((await readWslDistributionIdentity(distro)) !== distributionId) {
    throw new Error('WSL distribution was replaced during owner preparation')
  }
  return { distributionId, userName, userId, platform, libc, runtime, environment, execution }
}
